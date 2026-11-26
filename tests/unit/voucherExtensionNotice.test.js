// Member notice when an admin extends a voucher (Sir Dino, 2026-11-23).
// The SQL's "still in effect" rules are proven against a real MariaDB copy (see the
// rehearsal notes in deploy-state); these tests pin the shape, privacy and fail-soft rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const { getVoucherExtensionNotices, NOTICE_RECENT_DAYS } = require('../../services/voucherValidity');

function fakeExecutor(handler) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql), params }); return handler(sql, params); } };
}

const ROW = {
  id: 9, voucher_id: 501, clock: 'unused', new_expiry: '2027-01-05', extended_on: '2026-11-26',
  is_recent: 1, package_type: 20, voucher_amount: '5000.00',
  reason: 'internal note', admin_username: 'nogatuadmin',
};

test('maps a row and never returns the admin reason or name', async () => {
  const ex = fakeExecutor(async () => [[ROW]]);
  const out = await getVoucherExtensionNotices(7001, ex);
  assert.deepEqual(out, [{
    extensionId: 9, voucherId: 501, clock: 'unused', newExpiry: '2027-01-05', extendedOn: '2026-11-26',
    isRecent: true, packageType: 20, voucherAmount: 5000,
  }]);
  assert.doesNotMatch(ex.calls[0].sql, /\breason\b|admin_username|admin_id/);
  assert.deepEqual(ex.calls[0].params, [7001]);
});

test('the query only accepts the latest extension still governing an active, unexpired voucher', async () => {
  const ex = fakeExecutor(async () => [[]]);
  await getVoucherExtensionNotices(7001, ex);
  const sql = ex.calls[0].sql.replace(/\s+/g, ' ');
  assert.match(sql, /e\.id = \(SELECT MAX\(x\.id\) FROM voucher_validity_extensiontab x WHERE x\.voucher_id = e\.voucher_id\)/);
  assert.match(sql, /v\.status = 1/);
  assert.match(sql, /e\.clock = 'unused' AND v\.first_used_at IS NULL AND v\.expiry_date = e\.new_expiry AND v\.expiry_date >= NOW\(\)/);
  assert.match(sql, /e\.clock = 'used' AND v\.first_used_at IS NOT NULL AND v\.use_expires_at = e\.new_expiry AND v\.use_expires_at >= NOW\(\)/);
  assert.match(sql, /v\.uid = e\.uid/);
  assert.match(sql, new RegExp(`INTERVAL ${NOTICE_RECENT_DAYS} DAY`));
});

test('an invalid uid issues no query', async () => {
  const ex = fakeExecutor(async () => { throw new Error('must not run'); });
  for (const bad of [0, -1, 'abc', null, undefined, 1.5]) {
    assert.deepEqual(await getVoucherExtensionNotices(bad, ex), []);
  }
  assert.equal(ex.calls.length, 0);
});

test('a database without V051 yields no notices instead of an error', async () => {
  const ex = fakeExecutor(async () => { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; });
  assert.deepEqual(await getVoucherExtensionNotices(7001, ex), []);
});

test('any other database error is raised, not hidden', async () => {
  const ex = fakeExecutor(async () => { const e = new Error('boom'); e.code = 'ER_LOCK_DEADLOCK'; throw e; });
  await assert.rejects(() => getVoucherExtensionNotices(7001, ex), /boom/);
});

// ---------- route: GET /api/vouchers/notices returns recent ones only ----------

function loadVoucherRoutes(noticesImpl) {
  const routePath = path.join(repoRoot, 'routes', 'vouchers.js');
  const stubs = {
    [path.join(repoRoot, 'middleware', 'auth.js')]: { memberAuth: (req, res, next) => next() },
    [path.join(repoRoot, 'services', 'voucher.js')]: { getVouchers: async () => [], redeemVoucher: async () => ({}) },
    [path.join(repoRoot, 'services', 'voucherValidity.js')]: { getVoucherExtensionNotices: noticesImpl },
  };
  const saved = Object.keys(stubs).map((p) => [p, require.cache[p]]);
  for (const [p, exp] of Object.entries(stubs)) require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  delete require.cache[routePath];
  try { return require(routePath); } finally {
    delete require.cache[routePath];
    for (const [p, c] of saved) { if (c) require.cache[p] = c; else delete require.cache[p]; }
  }
}

async function callNotices(router, uid) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/notices' && l.route.methods.get);
  assert.ok(layer, 'GET /notices exists');
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { session: { uid } };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let next = false;
    await h(req, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

test('GET /notices returns only recent extensions for the session member', async () => {
  let askedFor = null;
  const router = loadVoucherRoutes(async (uid) => {
    askedFor = uid;
    return [{ extensionId: 2, isRecent: true }, { extensionId: 1, isRecent: false }];
  });
  const res = await callNotices(router, 7001);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { notices: [{ extensionId: 2, isRecent: true }] });
  assert.equal(askedFor, 7001);
});

test('GET /notices is a 500 with a generic message on failure', async () => {
  const saved = console.error; console.error = () => {};
  try {
    const router = loadVoucherRoutes(async () => { throw new Error('db down: detail'); });
    const res = await callNotices(router, 7001);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error' });
  } finally { console.error = saved; }
});

// ---------- getVouchers: the list never breaks because of the notice lookup ----------

function loadVoucherService(poolImpl) {
  const svcPath = path.join(repoRoot, 'services', 'voucher.js');
  const dbPath = path.join(repoRoot, 'config', 'database.js');
  const readinessPath = path.join(repoRoot, 'services', 'schemaReadiness.js');
  const saved = [dbPath, readinessPath].map((p) => [p, require.cache[p]]);
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: poolImpl } };
  const realReadiness = require(readinessPath);
  require.cache[readinessPath] = {
    id: readinessPath, filename: readinessPath, loaded: true,
    exports: { ...realReadiness, assertSchemaRequirements: async () => {} },
  };
  delete require.cache[svcPath];
  try { return require(svcPath); } finally {
    delete require.cache[svcPath];
    for (const [p, c] of saved) { if (c) require.cache[p] = c; else delete require.cache[p]; }
  }
}

const VOUCHER_ROWS = [
  { id: 501, uid: 7001, package_type: 20, voucher_amount: 5000, remaining_balance: 5000, issued_date: '2026-09-05',
    expiry_date: '2027-01-05', first_used_at: null, use_expires_at: null, status: 1, status_label: 'Active' },
  { id: 400, uid: 7001, package_type: 10, voucher_amount: 2500, remaining_balance: 0, issued_date: '2026-06-10',
    expiry_date: '2026-10-10', first_used_at: null, use_expires_at: null, status: 3, status_label: 'Fully Used' },
];

test('getVouchers attaches the extension (date only) to the matching voucher', async () => {
  const pool = {
    query: async (sql) => {
      if (/^\s*UPDATE voucherstab/i.test(sql)) return [{ affectedRows: 0 }];
      if (/voucher_validity_extensiontab/.test(sql)) return [[ROW]];
      if (/FROM voucherstab WHERE uid/.test(sql)) return [VOUCHER_ROWS];
      return [[]];
    },
  };
  const { getVouchers } = loadVoucherService(pool);
  const out = await getVouchers(7001);
  assert.deepEqual(out.find((v) => v.id === 501).validity_extension, { extendedOn: '2026-11-26', newExpiry: '2027-01-05', isRecent: true });
  assert.equal(out.find((v) => v.id === 400).validity_extension, null);
});

test('getVouchers still lists vouchers when the notice lookup fails', async () => {
  const saved = console.error; console.error = () => {};
  try {
    const pool = {
      query: async (sql) => {
        if (/^\s*UPDATE voucherstab/i.test(sql)) return [{ affectedRows: 0 }];
        if (/voucher_validity_extensiontab/.test(sql)) { const e = new Error('lock wait'); e.code = 'ER_LOCK_WAIT_TIMEOUT'; throw e; }
        if (/FROM voucherstab WHERE uid/.test(sql)) return [VOUCHER_ROWS];
        return [[]];
      },
    };
    const { getVouchers } = loadVoucherService(pool);
    const out = await getVouchers(7001);
    assert.equal(out.length, 2);
    assert.ok(out.every((v) => v.validity_extension === null));
  } finally { console.error = saved; }
});
