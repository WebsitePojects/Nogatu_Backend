const { test } = require('node:test');
const assert = require('node:assert');
const { createIdempotency, stableStringify } = require('../../middleware/idempotency');

function makeReq({ key, body = {}, uid = 42 } = {}) {
  return {
    method: 'POST',
    baseUrl: '/api/codes',
    path: '/maintenance',
    body,
    session: { uid },
    get: (h) => (h === 'Idempotency-Key' ? key : undefined),
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: undefined,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
  };
  return res;
}

// Scripted pool: each call shifts the next scripted result; records SQL.
function makePool(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const step = script.shift();
      if (!step) return [[]];
      if (step.throw) { const e = new Error(step.throw.msg || 'db'); e.code = step.throw.code; throw e; }
      return [step.result];
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('no key -> passes through without touching the pool', async () => {
  const pool = makePool([]);
  const mw = createIdempotency(pool)('codes.maintenance');
  let nexted = false;
  await mw(makeReq({}), makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(pool.calls.length, 0);
});

test('invalid key (too short / bad chars) -> passes through', async () => {
  const pool = makePool([]);
  const mw = createIdempotency(pool)('codes.maintenance');
  let nexted = false;
  await mw(makeReq({ key: 'ab!' }), makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(pool.calls.length, 0);
});

test('first request claims key, success response is stored', async () => {
  const pool = makePool([
    { result: { affectedRows: 1 } }, // INSERT claim
    { result: { affectedRows: 1 } }, // UPDATE -> done
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  const res = makeRes();
  let nexted = false;
  await mw(makeReq({ key: 'tap-0001-aaaa-bbbb' }), res, () => { nexted = true; });
  assert.equal(nexted, true);
  res.status(200).json({ success: true, producttype: 104 });
  await flush();
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /^INSERT INTO idempotency_keystab/);
  assert.match(pool.calls[1].sql, /SET status = 'done'/);
  assert.deepEqual(res.jsonBody, { success: true, producttype: 104 });
});

test('failure response releases the key for retry', async () => {
  const pool = makePool([
    { result: { affectedRows: 1 } }, // INSERT claim
    { result: { affectedRows: 1 } }, // DELETE release
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  const res = makeRes();
  await mw(makeReq({ key: 'tap-0002-aaaa-bbbb' }), res, () => {});
  res.status(400).json({ error: 'Invalid maintenance code' });
  await flush();
  assert.match(pool.calls[1].sql, /^DELETE FROM idempotency_keystab/);
});

test('duplicate while processing (fresh) -> 409, handler never runs', async () => {
  const pool = makePool([
    { throw: { code: 'ER_DUP_ENTRY' } }, // INSERT collides
    { result: [{ status: 'processing', stale: 0, request_hash: null }] },
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  const res = makeRes();
  let nexted = false;
  await mw(makeReq({ key: 'tap-0003-aaaa-bbbb' }), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 409);
});

test('duplicate after completion -> replays stored response, handler never runs', async () => {
  const pool = makePool([
    { throw: { code: 'ER_DUP_ENTRY' } },
    { result: [{ status: 'done', stale: 0, request_hash: null, response_code: 200, response_body: '{"success":true,"producttype":104}' }] },
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  const res = makeRes();
  let nexted = false;
  await mw(makeReq({ key: 'tap-0004-aaaa-bbbb' }), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Idempotency-Replayed'], 'true');
  assert.deepEqual(res.jsonBody, { success: true, producttype: 104 });
});

test('key reused with different body -> 422', async () => {
  const pool = makePool([
    { throw: { code: 'ER_DUP_ENTRY' } },
    { result: [{ status: 'done', stale: 0, request_hash: 'deadbeef'.repeat(8), response_code: 200, response_body: '{}' }] },
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  const res = makeRes();
  await mw(makeReq({ key: 'tap-0005-aaaa-bbbb', body: { code: 'OTHER' } }), res, () => {});
  assert.equal(res.statusCode, 422);
});

test('stale processing row is taken over (crashed first attempt)', async () => {
  const pool = makePool([
    { throw: { code: 'ER_DUP_ENTRY' } },
    { result: [{ status: 'processing', stale: 1, request_hash: null }] },
    { result: { affectedRows: 1 } }, // takeover DELETE wins
    { result: { affectedRows: 1 } }, // re-INSERT claim
  ]);
  const mw = createIdempotency(pool)('codes.maintenance');
  let nexted = false;
  await mw(makeReq({ key: 'tap-0006-aaaa-bbbb' }), makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
});

test('pool failure fails OPEN (CAS below is the hard guard)', async () => {
  const pool = makePool([{ throw: { code: 'ECONNREFUSED', msg: 'db down' } }]);
  const mw = createIdempotency(pool)('codes.maintenance');
  let nexted = false;
  await mw(makeReq({ key: 'tap-0007-aaaa-bbbb' }), makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
});
