const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const servicePath = path.join(repoRoot, 'services', 'voucherValidity.js');
const routePath = path.join(repoRoot, 'routes', 'admin', 'voucherManagement.js');

const svc = require(servicePath);
const { validateExtensionRequest, extendVoucherValidity, VoucherValidityError } = svc;

// Local-time "now" so the tests do not depend on the host timezone.
const NOW = new Date(2026, 10, 15, 10, 0, 0);
const GOOD_REASON = 'Approved by management';

function voucher(overrides = {}) {
  return {
    id: 501,
    uid: 7001,
    status: 1,
    remaining_balance: 2500,
    expiry_date: new Date(2026, 10, 20, 23, 59, 59),
    use_expires_at: null,
    first_used_at: null,
    ...overrides,
  };
}

function check(overrides = {}, args = {}) {
  return validateExtensionRequest({
    voucher: voucher(overrides),
    newExpiry: '2026-12-31',
    reason: GOOD_REASON,
    now: NOW,
    ...args,
  });
}

// ---------- pure validator ----------

test('valid unused voucher selects expiry_date clock', () => {
  const r = check();
  assert.equal(r.ok, true);
  assert.equal(r.clock, 'unused');
  assert.equal(r.column, 'expiry_date');
  assert.equal(r.newExpiryDate.getHours(), 23);
  assert.equal(r.newExpiryDate.getMinutes(), 59);
  assert.equal(r.newExpiryDate.getSeconds(), 59);
});

test('used voucher selects use_expires_at clock, ignoring expiry_date', () => {
  const r = check({
    first_used_at: new Date(2026, 9, 1),
    use_expires_at: new Date(2026, 10, 18, 23, 59, 59),
    expiry_date: new Date(2027, 5, 1), // far-future non-governing clock must not matter
  });
  assert.equal(r.ok, true);
  assert.equal(r.clock, 'used');
  assert.equal(r.column, 'use_expires_at');
  assert.equal(r.oldExpiry.getDate(), 18);
});

test('used clock: new date is compared against use_expires_at, not expiry_date', () => {
  const r = check({
    first_used_at: new Date(2026, 9, 1),
    use_expires_at: new Date(2026, 11, 31, 23, 59, 59),
    expiry_date: new Date(2026, 10, 16, 23, 59, 59),
  }, { newExpiry: '2026-12-20' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_LATER');
});

test('expired voucher (status 2, past date) is extendable', () => {
  const r = check({ status: 2, expiry_date: new Date(2026, 9, 1, 23, 59, 59) }, { newExpiry: '2026-11-25' });
  assert.equal(r.ok, true);
});

test('NOT_FOUND when no row', () => {
  assert.equal(validateExtensionRequest({ voucher: undefined, newExpiry: '2026-12-01', reason: GOOD_REASON, now: NOW }).code, 'NOT_FOUND');
});

test('status codes map to distinct errors', () => {
  assert.equal(check({ status: 3 }).code, 'FULLY_USED');
  assert.equal(check({ status: 4 }).code, 'SUSPENDED');
  assert.equal(check({ status: 5 }).code, 'REVOKED');
});

test('unknown / garbage status fails closed with NOT_EXTENDABLE', () => {
  for (const status of [0, 6, 99, -1, null, undefined, 'abc']) {
    assert.equal(check({ status }).code, 'NOT_EXTENDABLE', `status=${status}`);
  }
});

test('NO_BALANCE for zero, negative, null or non-numeric balance', () => {
  for (const remaining_balance of [0, -5, null, undefined, 'x']) {
    assert.equal(check({ remaining_balance }).code, 'NO_BALANCE', `balance=${remaining_balance}`);
  }
});

test('INVALID_REASON for short, blank, whitespace-padded short, too long, non-string', () => {
  for (const reason of ['', '    ', ' ab ', 'abcd', 'x'.repeat(501), null, undefined, 12345]) {
    assert.equal(check({}, { reason }).code, 'INVALID_REASON', `reason=${String(reason).slice(0, 10)}`);
  }
  assert.equal(check({}, { reason: '  12345  ' }).ok, true);
  assert.equal(check({}, { reason: 'x'.repeat(500) }).ok, true);
});

test('INVALID_DATE for anything but a real YYYY-MM-DD', () => {
  for (const newExpiry of [
    '', null, undefined, 20261231, '2026-12-31T00:00:00Z', '2026/12/31', '12-31-2026',
    '2026-2-3', '2026-13-01', '2026-02-30', '2026-00-10', '2026-12-32', 'tomorrow',
  ]) {
    assert.equal(check({}, { newExpiry }).code, 'INVALID_DATE', `newExpiry=${newExpiry}`);
  }
});

test('NOT_LATER when current expiry is still in the future (never shorten)', () => {
  // current expiry 2026-11-20 23:59:59 -> same day and earlier are refused
  assert.equal(check({}, { newExpiry: '2026-11-20' }).code, 'NOT_LATER');
  assert.equal(check({}, { newExpiry: '2026-11-18' }).code, 'NOT_LATER');
  assert.equal(check({}, { newExpiry: '2026-11-21' }).ok, true);
});

test('NOT_LATER when new date is today or in the past, even if the voucher expired long ago', () => {
  const expired = { status: 2, expiry_date: new Date(2026, 8, 1, 23, 59, 59) };
  assert.equal(check(expired, { newExpiry: '2026-11-14' }).code, 'NOT_LATER');
  // today 23:59:59 is after now (10:00) so it is strictly later
  assert.equal(check(expired, { newExpiry: '2026-11-15' }).ok, true);
});

test('null governing expiry fails closed (a voucher with no expiry on record is not extendable)', () => {
  assert.equal(check({ first_used_at: new Date(2026, 9, 1), use_expires_at: null }, { newExpiry: '2026-11-30' }).code, 'NO_GOVERNING_EXPIRY');
  assert.equal(check({ first_used_at: null, expiry_date: null }, { newExpiry: '2026-11-30' }).code, 'NO_GOVERNING_EXPIRY');
});

test('TOO_FAR beyond 6 months from now, boundary day allowed', () => {
  assert.equal(check({}, { newExpiry: '2027-05-15' }).ok, true);   // exactly +6 months
  assert.equal(check({}, { newExpiry: '2027-05-16' }).code, 'TOO_FAR');
  assert.equal(check({}, { newExpiry: '2030-01-01' }).code, 'TOO_FAR');
});

test('TOO_FAR month-end clamp: Aug 31 + 6 months is Feb 28, not Mar 3', () => {
  const now = new Date(2026, 7, 31, 10, 0, 0);
  const v = voucher({ expiry_date: new Date(2026, 8, 1, 23, 59, 59) });
  assert.equal(validateExtensionRequest({ voucher: v, newExpiry: '2027-02-28', reason: GOOD_REASON, now }).ok, true);
  assert.equal(validateExtensionRequest({ voucher: v, newExpiry: '2027-03-03', reason: GOOD_REASON, now }).code, 'TOO_FAR');
});

test('rules fire in spec order: status before balance before reason before date', () => {
  assert.equal(check({ status: 3, remaining_balance: 0 }, { reason: '', newExpiry: 'bad' }).code, 'FULLY_USED');
  assert.equal(check({ remaining_balance: 0 }, { reason: '', newExpiry: 'bad' }).code, 'NO_BALANCE');
  assert.equal(check({}, { reason: '', newExpiry: 'bad' }).code, 'INVALID_REASON');
  assert.equal(check({}, { newExpiry: 'bad' }).code, 'INVALID_DATE');
});

// ---------- write path ----------

// The service reads the DB clock (SELECT NOW()) so validation matches the MySQL-NOW() expiry
// sweep; the fake answers it with `dbNow` and logs it separately from the data queries.
function fakeConn({ row, updateAffected = 1, failOn, dbNow = NOW } = {}) {
  const log = [];
  return {
    log,
    released: false,
    async beginTransaction() { log.push({ op: 'begin' }); },
    async commit() { log.push({ op: 'commit' }); },
    async rollback() { log.push({ op: 'rollback' }); },
    release() { this.released = true; },
    async query(sql, params) {
      if (/SELECT NOW\(\) AS db_now/.test(sql)) {
        log.push({ op: 'clock', sql });
        return [[{ db_now: dbNow }]];
      }
      log.push({ op: 'query', sql, params });
      if (failOn && failOn.test(sql)) throw new Error('boom');
      if (/^\s*SELECT/i.test(sql)) return [row === undefined ? [] : [row]];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: updateAffected }];
      return [{ affectedRows: 1 }];
    },
  };
}

const ADMIN = { id: 3, username: 'superadmin' };

test('write path (unused): updates expiry_date only, with CAS predicates, audit row, commit', async () => {
  const conn = fakeConn({ row: voucher({ status: 2, expiry_date: new Date(2026, 9, 1, 23, 59, 59) }) });
  const out = await extendVoucherValidity({
    voucherId: 501, newExpiry: '2026-12-01', reason: ` ${GOOD_REASON} `, admin: ADMIN, conn, now: NOW,
  });

  const queries = conn.log.filter((l) => l.op === 'query');
  const [select, update, insert] = queries;
  assert.match(select.sql, /FOR UPDATE/);
  assert.match(update.sql, /SET expiry_date = \?, status = 1/);
  assert.doesNotMatch(update.sql, /use_expires_at/);
  assert.match(update.sql, /status IN \(1, 2\)/);
  assert.match(update.sql, /expiry_date <=> \?/);
  assert.match(update.sql, /\(first_used_at IS NULL\) = \?/);
  assert.deepEqual(update.params.slice(0, 2), ['2026-12-01 23:59:59', 501]);
  assert.equal(update.params[3], 1);
  assert.match(insert.sql, /INSERT INTO voucher_validity_extensiontab/);
  assert.equal(insert.params[2], 'unused');
  assert.equal(insert.params[5], 2); // old_status
  assert.equal(insert.params[6], GOOD_REASON); // trimmed
  assert.equal(insert.params[7], 3);
  assert.equal(insert.params[8], 'superadmin');
  assert.deepEqual(conn.log.map((l) => l.op).filter((o) => o !== 'query'), ['begin', 'clock', 'commit']);
  assert.deepEqual(out, {
    voucherId: 501, uid: 7001, clock: 'unused',
    oldExpiry: '2026-10-01 23:59:59', newExpiry: '2026-12-01 23:59:59', oldStatus: 2, newStatus: 1,
  });
  assert.equal(conn.released, false, 'caller-supplied connection must not be released');
});

test('write path (used): updates use_expires_at only, never expiry_date', async () => {
  const conn = fakeConn({
    row: voucher({ first_used_at: new Date(2026, 9, 1), use_expires_at: new Date(2026, 10, 18, 23, 59, 59) }),
  });
  const out = await extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW });
  const update = conn.log.find((l) => l.op === 'query' && /^\s*UPDATE/i.test(l.sql));
  assert.match(update.sql, /SET use_expires_at = \?, status = 1/);
  assert.doesNotMatch(update.sql, /expiry_date/);
  assert.match(update.sql, /use_expires_at <=> \?/);
  assert.equal(update.params[3], 0);
  assert.equal(out.clock, 'used');
});

test('write path never mentions money columns in any statement', async () => {
  const conn = fakeConn({ row: voucher() });
  await extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW });
  const update = conn.log.find((l) => l.op === 'query' && /^\s*UPDATE/i.test(l.sql));
  const insert = conn.log.find((l) => l.op === 'query' && /^\s*INSERT/i.test(l.sql));
  for (const stmt of [update, insert]) {
    assert.doesNotMatch(stmt.sql, /remaining_balance|voucher_amount|issued_date/i);
  }
  assert.doesNotMatch(update.sql, /payout|ttl/i);
});

test('write path rolls back with CONFLICT when the CAS UPDATE hits 0 rows; no audit row', async () => {
  const conn = fakeConn({ row: voucher(), updateAffected: 0 });
  await assert.rejects(
    extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW }),
    (e) => e instanceof VoucherValidityError && e.code === 'CONFLICT'
  );
  const ops = conn.log.map((l) => l.op);
  assert.ok(ops.includes('rollback'));
  assert.ok(!ops.includes('commit'));
  assert.ok(!conn.log.some((l) => l.op === 'query' && /INSERT/i.test(l.sql)));
});

test('write path rolls back on validation failure against the locked row; no UPDATE issued', async () => {
  const conn = fakeConn({ row: voucher({ status: 4 }) });
  await assert.rejects(
    extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW }),
    (e) => e.code === 'SUSPENDED'
  );
  assert.ok(conn.log.some((l) => l.op === 'rollback'));
  assert.ok(!conn.log.some((l) => l.op === 'query' && /^\s*(UPDATE|INSERT)/i.test(l.sql)));
});

test('write path: missing voucher -> NOT_FOUND + rollback', async () => {
  const conn = fakeConn({ row: undefined });
  await assert.rejects(
    extendVoucherValidity({ voucherId: 999, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW }),
    (e) => e.code === 'NOT_FOUND'
  );
  assert.ok(conn.log.some((l) => l.op === 'rollback'));
});

test('write path rolls back when the audit insert fails (no half-applied extension)', async () => {
  const conn = fakeConn({ row: voucher(), failOn: /INSERT INTO voucher_validity_extensiontab/ });
  await assert.rejects(
    extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn, now: NOW }),
    /boom/
  );
  const ops = conn.log.map((l) => l.op);
  assert.ok(ops.includes('rollback'));
  assert.ok(!ops.includes('commit'));
});

test('default connection path: called WITHOUT conn uses config/database pool and releases it', async () => {
  const dbPath = path.join(repoRoot, 'config', 'database.js');
  const saved = require.cache[dbPath];
  const conn = fakeConn({ row: voucher() });
  let acquired = 0;
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { pool: { getConnection: async () => { acquired += 1; return conn; } } },
  };
  try {
    const out = await extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, now: NOW });
    assert.equal(out.newStatus, 1);
    assert.equal(acquired, 1);
    assert.equal(conn.released, true, 'self-acquired connection must be released');
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
  }
});

// ---------- route ----------

function withStubbedModules(stubs, load) {
  const saved = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  try {
    return load();
  } finally {
    for (const [p, cached] of saved) {
      if (cached) require.cache[p] = cached; else delete require.cache[p];
    }
  }
}

function loadRouter({ extend, poolQuery } = {}) {
  delete require.cache[routePath];
  const tag = (rights) => Object.assign((req, res, next) => next(), { rights });
  const adminAuth = Object.assign((req, res, next) => next(), { isAdminAuth: true });
  const router = withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: { adminAuth, adminRights: tag },
    [path.join(repoRoot, 'middleware', 'idempotency.js')]: {
      idempotent: (scope) => Object.assign((req, res, next) => next(), { idempotencyScope: scope }),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: poolQuery || (async () => [[]]), getConnection: async () => ({}) },
    },
    [path.join(repoRoot, 'services', 'voucher.js')]: {
      buildVoucherExpiryLabel: () => '', createManualVoucherAvailment: async () => ({}),
      getVoucherExpiryMode: () => 'unused', getVoucherAvailmentById: async () => ({}),
      getVoucherAvailments: async () => [], isEligibleForPackageVoucher: async () => ({}),
      issuePackageVoucher: async () => ({}), listVoucherGrantCandidates: async () => ({}),
      resolveVoucherSources: async () => new Map(), markVoucherAvailmentClaimed: async () => ({}),
      updateManualVoucherAvailment: async () => ({}),
    },
    [path.join(repoRoot, 'services', 'schemaReadiness.js')]: {
      SCHEMA_REQUIREMENTS: {}, assertSchemaRequirements: async () => {},
    },
    [servicePath]: { ...svc, extendVoucherValidity: extend || (async () => ({ ok: 1 })) },
  }, () => require(routePath));
  delete require.cache[routePath];
  return router;
}

function findRoute(router, method, routeStr) {
  const layer = router.stack.find((l) => l.route && l.route.path === routeStr && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${routeStr} not registered`);
  return layer.route.stack.map((s) => s.handle);
}

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('route: extend-validity is super-admin only, behind adminAuth + idempotency', () => {
  const handlers = findRoute(loadRouter(), 'post', '/:id/extend-validity');
  assert.equal(handlers.length, 4);
  assert.equal(handlers[0].isAdminAuth, true);
  assert.deepEqual(handlers[1].rights, [1]);
  assert.equal(handlers[2].idempotencyScope, 'admin.voucherManagement.extendValidity');
});

test('route: validity-history readable by rights 1,2,3', () => {
  const handlers = findRoute(loadRouter(), 'get', '/:id/validity-history');
  assert.deepEqual(handlers[1].rights, [1, 2, 3]);
});

test('route: service errors map to 404 / 409 / 400 with code; success is 200 {success,data}', async () => {
  const cases = [['NOT_FOUND', 404], ['CONFLICT', 409], ['SUSPENDED', 400], ['TOO_FAR', 400], ['NOT_LATER', 400]];
  for (const [code, status] of cases) {
    const router = loadRouter({ extend: async () => { throw new VoucherValidityError(code, `msg ${code}`); } });
    const handler = findRoute(router, 'post', '/:id/extend-validity').at(-1);
    const res = mockRes();
    await handler({ params: { id: '501' }, body: {}, session: { adminid: 'superadmin', adminNumericId: 3 } }, res);
    assert.equal(res.statusCode, status, code);
    assert.deepEqual(res.body, { success: false, error: `msg ${code}`, code });
  }

  let received;
  const router = loadRouter({ extend: async (args) => { received = args; return { voucherId: 501 }; } });
  const handler = findRoute(router, 'post', '/:id/extend-validity').at(-1);
  const res = mockRes();
  await handler({
    params: { id: '501' },
    body: { newExpiry: '2026-12-01', reason: GOOD_REASON },
    session: { adminid: 'superadmin', adminNumericId: 3 },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { voucherId: 501 } });
  assert.deepEqual(received.admin, { id: 3, username: 'superadmin' });
  assert.equal(received.voucherId, 501);
});

test('route: invalid id is 400 without calling the service; unexpected error is 500 without leaking', async () => {
  let called = 0;
  const router = loadRouter({ extend: async () => { called += 1; return {}; } });
  const handler = findRoute(router, 'post', '/:id/extend-validity').at(-1);
  for (const id of ['abc', '0', '-3', '1.5']) {
    const res = mockRes();
    await handler({ params: { id }, body: {}, session: { adminid: 'superadmin', adminNumericId: 3 } }, res);
    assert.equal(res.statusCode, 400, id);
    assert.equal(res.body.code, 'INVALID_ID');
  }
  assert.equal(called, 0);

  const boom = loadRouter({ extend: async () => { throw new Error('secret db detail'); } });
  const res = mockRes();
  const origErr = console.error;
  console.error = () => {};
  try {
    await findRoute(boom, 'post', '/:id/extend-validity').at(-1)({ params: { id: '5' }, body: {}, session: { adminid: 'superadmin', adminNumericId: 3 } }, res);
  } finally {
    console.error = origErr;
  }
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /secret/);
});

test('route: validity-history queries newest-first with LIMIT 50 keyed on the voucher id', async () => {
  const calls = [];
  const router = loadRouter({ poolQuery: async (sql, params) => { calls.push({ sql, params }); return [[{ id: 1 }]]; } });
  const handler = findRoute(router, 'get', '/:id/validity-history').at(-1);
  const res = mockRes();
  await handler({ params: { id: '501' }, session: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: [{ id: 1 }] });
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(calls[0].sql, /LIMIT 50/);
  assert.deepEqual(calls[0].params, [501]);
});

test('write path judges dates on the DB clock, not the Node clock', async () => {
  // DB says it is Jan 2026; Node's real clock is later. A Mar 2026 date is valid only on the DB clock.
  const dbNow = new Date(2026, 0, 10, 9, 0, 0);
  const conn = fakeConn({ row: voucher({ expiry_date: new Date(2026, 1, 1, 23, 59, 59) }), dbNow });
  const out = await extendVoucherValidity({ voucherId: 501, newExpiry: '2026-03-01', reason: GOOD_REASON, admin: ADMIN, conn });
  assert.equal(out.newExpiry, '2026-03-01 23:59:59');
  assert.ok(conn.log.some((l) => l.op === 'clock'), 'DB clock must be read');
});

test('write path refuses when the DB clock cannot be read', async () => {
  const conn = fakeConn({ row: voucher(), dbNow: null });
  await assert.rejects(
    extendVoucherValidity({ voucherId: 501, newExpiry: '2026-12-01', reason: GOOD_REASON, admin: ADMIN, conn }),
    (e) => e.code === 'CLOCK_UNAVAILABLE'
  );
  assert.ok(conn.log.some((l) => l.op === 'rollback'));
  assert.ok(!conn.log.some((l) => l.op === 'commit'));
});

test('route: a session without a numeric admin id is refused before any service call', async () => {
  let called = 0;
  const router = loadRouter({ extend: async () => { called += 1; return {}; } });
  const handler = findRoute(router, 'post', '/:id/extend-validity').at(-1);
  for (const session of [{}, { adminid: 'superadmin' }, { adminid: 'x', adminNumericId: 0 }, { adminid: 'x', adminNumericId: 'abc' }]) {
    const res = mockRes();
    await handler({ params: { id: '501' }, body: { newExpiry: '2026-12-01', reason: 'valid reason' }, session }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'NO_ADMIN_ID');
  }
  assert.equal(called, 0);
});
