'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Pins the TRANSACTIONAL path of generateCodes(): lock -> batch row -> codes -> commit, the
// idempotent replay, and lock release on every exit. The AR release reuses this core inside its
// own transaction, so these tests must pass both before and after that refactor.

const repoRoot = path.resolve(__dirname, '..', '..');
const codeGenPath = path.join(repoRoot, 'services', 'codeGeneration.js');
const KEY = 'test-key-0001';

function makeFakeDb({ collideFirst = false } = {}) {
  const state = {
    batches: [], codes: [], links: [], events: [], log: [],
    locks: 0, released: 0, began: 0, commits: 0, rollbacks: 0, conns: 0, releasedConns: 0,
    nextCodeId: 5000, nextBatchId: 1, collideFirst,
  };
  const conn = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      state.log.push(q.slice(0, 60));
      if (q.startsWith('SELECT GET_LOCK')) { state.locks += 1; return [[{ lockState: 1 }]]; }
      if (q.startsWith('SELECT RELEASE_LOCK')) { state.released += 1; return [[{}]]; }
      if (q.startsWith('SELECT * FROM code_generation_batchtab') || q.startsWith('SELECT request_hash, status, codes_json FROM code_generation_batchtab')) {
        const [actor, key] = params;
        return [state.batches.filter((b) => b.actor === actor && b.key === key)];
      }
      if (q.startsWith('INSERT INTO code_generation_batchtab')) {
        const [key, actor, , arNumber, hash] = params;
        state.batches.push({ id: state.nextBatchId++, key, actor, ar_number: arNumber, request_hash: hash, status: 'processing', codes_json: null });
        return [{ insertId: state.nextBatchId - 1 }];
      }
      if (q.startsWith('SELECT id FROM code_generation_batchtab')) {
        const [actor, key] = params;
        return [[state.batches.find((b) => b.actor === actor && b.key === key)]];
      }
      if (q.startsWith('SELECT MAX(id) AS maxId FROM codestab')) return [[{ maxId: 1000 }]];
      if (q.startsWith('SELECT id FROM codestab WHERE code')) {
        if (state.collideFirst) { state.collideFirst = false; return [[{ id: 1 }]]; }
        return [[]];
      }
      if (q.startsWith('INSERT INTO codestab')) {
        const id = state.nextCodeId++;
        state.codes.push({ id, code: params[0], producttype: params[1] });
        return [{ insertId: id }];
      }
      if (q.startsWith('INSERT IGNORE INTO activation_code_usagetab')) { state.events.push(params[2]); return [{}]; }
      if (q.startsWith('INSERT INTO code_generation_batch_codetab')) { state.links.push(params); return [{}]; }
      if (q.startsWith('UPDATE code_generation_batchtab SET status')) {
        const [json, id] = params;
        const b = state.batches.find((x) => x.id === id);
        b.status = 'completed'; b.codes_json = json;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL in fake: ${q.slice(0, 80)}`);
    },
    async beginTransaction() { state.began += 1; },
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() { state.releasedConns += 1; },
    destroy() {},
  };
  const pool = {
    async getConnection() { state.conns += 1; return conn; },
    async query() { throw new Error('generator must use the connection, not the pool'); },
  };
  return { state, pool };
}

function loadGenerator(pool) {
  delete require.cache[codeGenPath];
  const dbPath = path.join(repoRoot, 'config', 'database.js');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
  try {
    return require(codeGenPath);
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
    delete require.cache[codeGenPath];
  }
}

const admin = { adminUsername: 'tester', actorAdminId: 7 };
const opts = (extra = {}) => ({ arNumber: '2026000123', idempotencyKey: KEY, ...extra });

test('happy path: one lock, one transaction, N codes, batch completed, commit, lock + conn released', async () => {
  const { state, pool } = makeFakeDb();
  const { generateCodes } = loadGenerator(pool);
  const codes = await generateCodes(3, 30, 1, 1, admin, opts());

  assert.equal(codes.length, 3);
  assert.equal(new Set(codes).size, 3, 'codes are distinct');
  assert.equal(state.codes.length, 3);
  assert.equal(state.links.length, 3, 'every code is linked to the batch');
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].status, 'completed');
  assert.deepEqual(JSON.parse(state.batches[0].codes_json), codes);
  assert.equal(state.batches[0].ar_number, '2026000123');
  assert.deepEqual([state.locks, state.began, state.commits, state.rollbacks], [1, 1, 1, 0]);
  assert.equal(state.released, 1, 'generation lock released');
  assert.equal(state.releasedConns, 1, 'connection returned to pool');
  assert.deepEqual(state.events, ['generated', 'generated', 'generated']);
});

test('a code-string collision skips to the next number instead of reusing it', async () => {
  const { state, pool } = makeFakeDb({ collideFirst: true });
  const { generateCodes } = loadGenerator(pool);
  const codes = await generateCodes(1, 30, 1, 1, admin, opts());
  assert.equal(codes.length, 1);
  assert.equal(state.codes.length, 1);
});

test('replay: the same key + payload returns the SAME codes, writes nothing, and rolls back', async () => {
  const { state, pool } = makeFakeDb();
  const { generateCodes } = loadGenerator(pool);
  const first = await generateCodes(2, 30, 1, 1, admin, opts());
  const codesBefore = state.codes.length;
  const second = await generateCodes(2, 30, 1, 1, admin, opts());

  assert.deepEqual(second, first);
  assert.equal(state.codes.length, codesBefore, 'replay must not mint new codes');
  assert.equal(state.rollbacks, 1, 'replay rolls back instead of committing');
  assert.equal(state.released, 2, 'lock released on both calls');
});

test('same key with a DIFFERENT payload is refused', async () => {
  const { pool } = makeFakeDb();
  const { generateCodes } = loadGenerator(pool);
  await generateCodes(2, 30, 1, 1, admin, opts());
  await assert.rejects(
    () => generateCodes(3, 30, 1, 1, admin, opts()),
    (err) => err.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  );
});

test('a batch still processing is reported as in progress, and the lock is still released', async () => {
  const { state, pool } = makeFakeDb();
  const { generateCodes } = loadGenerator(pool);
  // Simulate a crashed earlier attempt that left the batch row in 'processing'.
  await generateCodes(1, 30, 1, 1, admin, opts());
  state.batches[0].status = 'processing';
  await assert.rejects(
    () => generateCodes(1, 30, 1, 1, admin, opts()),
    (err) => err.code === 'GENERATION_IN_PROGRESS'
  );
  assert.equal(state.released, 2);
});

test('lock NOT acquired: nothing is written and the error is surfaced', async () => {
  const { state, pool } = makeFakeDb();
  const conn = await pool.getConnection();
  const originalQuery = conn.query;
  conn.query = async (sql, params) => (sql.startsWith('SELECT GET_LOCK') ? [[{ lockState: 0 }]] : originalQuery(sql, params));
  pool.getConnection = async () => conn;
  const { generateCodes } = loadGenerator(pool);
  await assert.rejects(() => generateCodes(1, 30, 1, 1, admin, opts()), /Unable to allocate codes/);
  assert.equal(state.codes.length, 0);
  assert.equal(state.began, 0);
});
