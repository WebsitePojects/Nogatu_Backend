'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// POST /api/admin/voucher-management/grant must:
//  - reject the WHOLE request at the boundary on any invalid uid (fail closed),
//  - use the shared isEligibleForPackageVoucher/issuePackageVoucher helpers so this
//    admin path can never diverge from the automatic upgrade-grant path,
//  - report a per-uid reason instead of a silent skip counter,
//  - be wrapped in the idempotency middleware,
//  - run each grant in its own connection + transaction (one bad uid can't roll
//    back or block the others),
//  - never UPDATE/DELETE voucherstab — grants are additive/INSERT-only.
//
// services/voucher.js is owned by a parallel builder in this worktree, so it is
// fully mocked here per the documented interface contract:
//   isEligibleForPackageVoucher(conn, uid) -> { eligible, reason, currentTier, amount }
//   issuePackageVoucher(conn, uid, packageType, options = {}) -> new row id | null

const repoRoot = path.resolve(__dirname, '..', '..');
const routePath = path.join(repoRoot, 'routes', 'admin', 'voucherManagement.js');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function withStubbedModules(stubs, loadModule) {
  const saved = new Map();

  for (const [absolutePath, exports] of Object.entries(stubs)) {
    saved.set(absolutePath, require.cache[absolutePath]);
    require.cache[absolutePath] = {
      id: absolutePath,
      filename: absolutePath,
      loaded: true,
      exports,
    };
  }

  try {
    return loadModule();
  } finally {
    for (const [absolutePath, cached] of saved.entries()) {
      if (cached) {
        require.cache[absolutePath] = cached;
      } else {
        delete require.cache[absolutePath];
      }
    }
  }
}

function getMatchingHandlers(router, method, routeMatchPath) {
  const handlers = [];

  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routeMatchPath && layer.route.methods[method]) {
      handlers.push(...layer.route.stack.map((entry) => entry.handle));
      continue;
    }

    if (!layer.route && typeof layer.handle === 'function') {
      handlers.push(layer.handle);
    }
  }

  return handlers;
}

async function runHandlers(handlers, req, res) {
  async function dispatch(index) {
    const handler = handlers[index];
    if (!handler) return;

    const maybePromise = handler(req, res, (err) => {
      if (err) throw err;
      return dispatch(index + 1);
    });

    if (maybePromise && typeof maybePromise.then === 'function') {
      await maybePromise;
    }
  }

  await dispatch(0);
}

// One fake DB connection per pool.getConnection() call; each connection records
// its own event order so a test can assert "one connection/transaction per uid"
// and "a failed uid rolls back only ITS OWN connection".
function makePoolStub() {
  const connectionsLog = [];
  const pool = {
    async query() {
      return [[]];
    },
    async getConnection() {
      const events = [];
      connectionsLog.push(events);
      return {
        async query() {
          return [{}];
        },
        async beginTransaction() {
          events.push('beginTransaction');
        },
        async commit() {
          events.push('commit');
        },
        async rollback() {
          events.push('rollback');
        },
        release() {
          events.push('release');
        },
      };
    },
  };
  return { pool, connectionsLog };
}

// scenarios: { [uid]: { eligible, reason, currentTier, amount, throwOnIssue, insertedId } }
// A uid with no scenario entry behaves like an unknown account (not eligible).
// Once a uid has been successfully "issued", any LATER call for the same uid in
// the same test run reports already_has_voucher_for_current_tier — this mirrors
// what the real DB-backed isEligibleForPackageVoucher would see if the SAME uid
// appears twice in one request array (sequential processing, second read happens
// after the first commit).
function makeVoucherServiceStub(scenarios = {}) {
  const eligibilityCalls = [];
  const issueCalls = [];
  const grantedUids = new Set();

  async function isEligibleForPackageVoucher(conn, uid) {
    eligibilityCalls.push(uid);
    const scenario = scenarios[uid];

    if (grantedUids.has(uid)) {
      return {
        eligible: false,
        reason: 'already_has_voucher_for_current_tier',
        currentTier: scenario?.currentTier ?? null,
        amount: scenario?.amount ?? null,
      };
    }

    if (!scenario) {
      return { eligible: false, reason: 'account_not_found', currentTier: null, joinedTier: null, amount: null };
    }

    return {
      eligible: scenario.eligible !== false,
      reason: scenario.reason || (scenario.eligible === false ? 'not_eligible' : 'eligible'),
      currentTier: scenario.currentTier ?? null,
      // Defaults to 0, which never equals a real tier (10-60), so every existing
      // scenario reads as an UPGRADED member and the upgraded-only policy is a
      // no-op for them. Set joinedTier === currentTier to model a never-upgraded
      // (pre-launch legacy) member and exercise the `not_upgraded` refusal.
      joinedTier: scenario.joinedTier ?? 0,
      amount: scenario.amount ?? null,
    };
  }

  async function issuePackageVoucher(conn, uid, packageType) {
    issueCalls.push({ uid, packageType });
    const scenario = scenarios[uid] || {};
    if (scenario.throwOnIssue) {
      throw new Error(`simulated issuePackageVoucher failure for uid ${uid}`);
    }
    grantedUids.add(uid);
    return scenario.insertedId ?? 10000 + Number(uid);
  }

  return { isEligibleForPackageVoucher, issuePackageVoucher, eligibilityCalls, issueCalls };
}

function loadVoucherManagementRouterForGrant({ scenarios = {}, idempotencyCapture = {} } = {}) {
  delete require.cache[routePath];

  const schemaRequirementSet = {
    VOUCHERS: 'VOUCHERS',
    VOUCHER_TRANSACTIONS: 'VOUCHER_TRANSACTIONS',
    VOUCHER_GRANTS: 'VOUCHER_GRANTS',
    VOUCHER_LIST: 'VOUCHER_LIST',
  };

  const { pool, connectionsLog } = makePoolStub();
  const voucherServiceStub = makeVoucherServiceStub(scenarios);

  const router = withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    // Stubbed so the test never touches the real DB-backed idempotency store;
    // captures the scope string so the test can prove the route is wrapped.
    [path.join(repoRoot, 'middleware', 'idempotency.js')]: {
      idempotent: (scope) => {
        idempotencyCapture.scope = scope;
        idempotencyCapture.calls = (idempotencyCapture.calls || 0) + 1;
        return (req, res, next) => next();
      },
    },
    [path.join(repoRoot, 'config', 'database.js')]: { pool },
    [path.join(repoRoot, 'services', 'voucher.js')]: voucherServiceStub,
    [path.join(repoRoot, 'services', 'schemaReadiness.js')]: {
      SCHEMA_REQUIREMENTS: schemaRequirementSet,
      assertSchemaRequirements: async () => {},
    },
  }, () => require(routePath));

  return { router, connectionsLog, voucherServiceStub };
}

// ── Boundary validation ──────────────────────────────────────────────────

test('grant route rejects a non-array uids body with 400 and touches no DB', async () => {
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant();
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: 'not-an-array' }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(connectionsLog.length, 0);
  assert.equal(voucherServiceStub.eligibilityCalls.length, 0);
});

test('grant route rejects an empty uids array with 400', async () => {
  const { router, connectionsLog } = loadVoucherManagementRouterForGrant();
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: [] }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(connectionsLog.length, 0);
});

test('grant route rejects the WHOLE batch (fail closed) when any element is not a positive integer', async () => {
  const invalidElements = ['5', 5.5, -1, 0, null, undefined, {}, [], true, NaN, '5abc'];

  for (const bad of invalidElements) {
    const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({
      scenarios: { 111: { eligible: true, currentTier: 10, amount: 2500 } },
    });
    const handlers = getMatchingHandlers(router, 'post', '/grant');
    const req = { body: { uids: [111, bad] }, session: { adminid: 1 } };
    const res = createResponse();

    await runHandlers(handlers, req, res);

    assert.equal(res.statusCode, 400, `expected 400 for invalid element ${JSON.stringify(bad)}`);
    assert.equal(connectionsLog.length, 0, `no DB connection should open for invalid element ${JSON.stringify(bad)}`);
    assert.equal(voucherServiceStub.eligibilityCalls.length, 0,
      `the VALID uid (111) must not be processed when a sibling element ${JSON.stringify(bad)} is invalid`);
  }
});

test('grant route rejects a batch above the size cap with 400', async () => {
  const { router, connectionsLog } = loadVoucherManagementRouterForGrant();
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const hugeUids = Array.from({ length: 501 }, (_, i) => i + 1);
  const req = { body: { uids: hugeUids }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(connectionsLog.length, 0);
});

// ── Per-uid reporting ─────────────────────────────────────────────────────

test('grant route processes a mixed batch and returns per-uid granted/skipped reasons', async () => {
  const scenarios = {
    701: { eligible: true, currentTier: 30, amount: 10000 },
    702: { eligible: false, reason: 'account_not_found' },
    703: { eligible: false, reason: 'unknown_package', amount: null },
  };
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: [701, 702, 703] }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.granted, 1);
  assert.equal(res.body.skipped, 2);
  // FE compat: VoucherGrant.jsx reads res.data.skippedCount — must keep mirroring it.
  assert.equal(res.body.skippedCount, 2);
  assert.equal(res.body.results.length, 3);

  const byUid = Object.fromEntries(res.body.results.map((r) => [r.uid, r]));
  assert.equal(byUid[701].granted, true);
  assert.equal(byUid[701].reason, 'eligible');
  assert.equal(byUid[701].amount, 10000);
  assert.equal(byUid[702].granted, false);
  assert.equal(byUid[702].reason, 'account_not_found');
  assert.equal(byUid[703].granted, false);
  assert.equal(byUid[703].reason, 'unknown_package');

  assert.equal(voucherServiceStub.issueCalls.length, 1);
  assert.equal(voucherServiceStub.issueCalls[0].uid, 701);
  assert.equal(voucherServiceStub.issueCalls[0].packageType, 30);

  // Each grant is its OWN connection + transaction — never one shared transaction
  // for the whole batch.
  assert.equal(connectionsLog.length, 3);
  assert.deepEqual(connectionsLog[0], ['beginTransaction', 'commit', 'release']);
  assert.deepEqual(connectionsLog[1], ['beginTransaction', 'rollback', 'release']);
  assert.deepEqual(connectionsLog[2], ['beginTransaction', 'rollback', 'release']);
});

// ── Idempotency wrapping ──────────────────────────────────────────────────

test('POST /grant is wrapped in the idempotency middleware with a stable scope', () => {
  const idempotencyCapture = {};
  loadVoucherManagementRouterForGrant({ idempotencyCapture });

  assert.equal(idempotencyCapture.calls, 1, 'idempotent(scope) must be called exactly once when the router loads');
  assert.equal(typeof idempotencyCapture.scope, 'string');
  assert.ok(idempotencyCapture.scope.length > 0);
  assert.equal(idempotencyCapture.scope, 'admin.voucherManagement.grant');
});

// ── Isolation: one bad uid cannot roll back or block the others ───────────

test('a uid that throws mid-issue is skipped without rolling back or blocking other uids', async () => {
  const scenarios = {
    801: { eligible: true, currentTier: 10, amount: 2500, throwOnIssue: true },
    802: { eligible: true, currentTier: 20, amount: 5000 },
  };
  const { router, connectionsLog } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: [801, 802] }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.granted, 1);
  assert.equal(res.body.skipped, 1);

  const byUid = Object.fromEntries(res.body.results.map((r) => [r.uid, r]));
  assert.equal(byUid[801].granted, false);
  assert.equal(byUid[801].reason, 'error');
  assert.equal(byUid[802].granted, true);

  assert.equal(connectionsLog.length, 2);
  assert.deepEqual(connectionsLog[0], ['beginTransaction', 'rollback', 'release'],
    'the throwing uid rolls back only its own connection');
  assert.deepEqual(connectionsLog[1], ['beginTransaction', 'commit', 'release'],
    'the other uid still commits on its own connection');
});

// ── Same uid twice in one array: additive semantics must not double-insert ──

test('the same uid appearing twice in one request array is granted once, not twice', async () => {
  const scenarios = {
    901: { eligible: true, currentTier: 10, amount: 2500 },
  };
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: [901, 901] }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.granted, 1, 'only the first occurrence is granted');
  assert.equal(res.body.skipped, 1, 'the second occurrence is skipped, not double-inserted');
  assert.equal(voucherServiceStub.issueCalls.length, 1,
    'issuePackageVoucher (the INSERT) must run exactly once for this uid');

  assert.equal(res.body.results[0].granted, true);
  assert.equal(res.body.results[1].granted, false);
  assert.equal(res.body.results[1].reason, 'already_has_voucher_for_current_tier');

  assert.equal(connectionsLog.length, 2, 'two independent connections/transactions, one per array entry');
});

// ── INSERT-only guarantee ───────────────────────────────────────────────

// NOTE: the file also contains legitimate, pre-existing UPDATE voucherstab
// statements in the unrelated /:id/suspend and /:id/unsuspend routes (out of
// scope here). "Grants are INSERT-only" is a property of the grant validator +
// handler specifically, so the source slice below is scoped to exactly that
// code (from validateGrantUids through the end of the file, where the /grant
// route is defined) rather than the whole file.
test('the grant validator + handler contain no UPDATE/DELETE against voucherstab', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  const start = src.indexOf('function validateGrantUids');
  assert.ok(start > -1, 'validateGrantUids must exist in routes/admin/voucherManagement.js');
  const slice = src.slice(start);

  assert.ok(!/UPDATE\s+voucherstab/i.test(slice),
    'the grant route must never UPDATE voucherstab — grants are additive/INSERT-only');
  assert.ok(!/DELETE\s+FROM\s+voucherstab/i.test(slice),
    'the grant route must never DELETE from voucherstab');
  assert.match(slice, /isEligibleForPackageVoucher/, 'must use the shared eligibility helper');
  assert.match(slice, /issuePackageVoucher/, 'must use the shared issue helper (INSERT only)');
});

// -- Grant policy (changed 2026-08-07 by the account owner) ---------------
// An admin may grant a voucher to ANY member, upgraded or not. The only refusal
// left is the DUPLICATE guard (already_has_voucher_for_current_tier), because
// vouchers are additive per TIER. These tests pin that decision so the removed
// upgraded-only gate is not silently reintroduced as a "fix".
// Consequence, recorded deliberately: the grantable population is ~7,177 members
// / PHP 40,755,000, bounded now only by MAX_GRANT_BATCH_SIZE and the UI total.

test('POLICY: a never-upgraded (legacy) member IS granted - no upgraded-only refusal', async () => {
  const scenarios = {
    // joinedTier === currentTier -> registered Bronze, still Bronze, never upgraded.
    601: { eligible: true, currentTier: 10, joinedTier: 10, amount: 2500 },
  };
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const res = createResponse();

  await runHandlers(handlers, { body: { uids: [601] }, session: { adminid: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.granted, 1);
  assert.deepEqual(res.body.results, [
    { uid: 601, granted: true, reason: 'eligible', amount: 2500 },
  ]);
  assert.deepEqual(voucherServiceStub.issueCalls, [{ uid: 601, packageType: 10 }]);
  assert.ok(connectionsLog[0].includes('commit'));
  assert.ok(!/not_upgraded/.test(JSON.stringify(res.body)),
    'the not_upgraded refusal must be gone from the grant route');
});

test('DUPLICATE GUARD stays: a member already holding a voucher for their CURRENT tier is refused', async () => {
  // Not a policy gate - vouchers are additive per TIER, so a second voucher for a
  // package the member already holds is duplicate value, not a grant.
  const scenarios = {
    602: {
      eligible: false,
      reason: 'already_has_voucher_for_current_tier',
      currentTier: 60,
      joinedTier: 10,
      amount: 150000,
    },
  };
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const res = createResponse();

  await runHandlers(handlers, { body: { uids: [602] }, session: { adminid: 1 } }, res);

  assert.equal(res.body.granted, 0);
  assert.equal(res.body.results[0].reason, 'already_has_voucher_for_current_tier');
  assert.deepEqual(voucherServiceStub.issueCalls, [],
    'must not issue a second PHP 150,000 Diamond voucher to the same member');
  assert.ok(connectionsLog[0].includes('rollback'));
  assert.ok(!connectionsLog[0].includes('commit'));
});

test('an upgraded member is granted normally', async () => {
  const scenarios = { 603: { eligible: true, currentTier: 20, joinedTier: 10, amount: 5000 } };
  const { router, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const res = createResponse();

  await runHandlers(handlers, { body: { uids: [603] }, session: { adminid: 1 } }, res);

  assert.equal(res.body.granted, 1);
  assert.deepEqual(voucherServiceStub.issueCalls, [{ uid: 603, packageType: 20 }]);
});

test('the unbounded bulk grant route and helper are GONE', () => {
  const { router } = loadVoucherManagementRouterForGrant();
  // NOTE: getMatchingHandlers() appends every router-level middleware regardless of
  // path, so it can never return 0 and cannot prove a route's absence. Inspect the
  // registered route paths directly instead.
  const registered = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  assert.ok(!registered.some((entry) => entry.endsWith(' /grant-existing')),
    `POST /grant-existing issued vouchers to every member without one — it must not exist. Registered: ${registered.join(' | ')}`);
  assert.ok(registered.some((entry) => entry === 'post /grant'),
    'the per-uid POST /grant route must still be registered');

  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(!/router\.post\(\s*['"]\/grant-existing['"]/.test(src),
    'no route may register /grant-existing');

  const serviceSrc = fs.readFileSync(path.join(repoRoot, 'services', 'voucher.js'), 'utf8');
  assert.ok(!/^\s*async function grantVouchersToExistingMembers/m.test(serviceSrc),
    'grantVouchersToExistingMembers (unbounded INSERT...SELECT) must not be defined');
  assert.ok(!/^\s*grantVouchersToExistingMembers,/m.test(serviceSrc),
    'grantVouchersToExistingMembers must not be exported');
});

// ── Candidate-list views (behavioural: capture the real generated SQL) ────
// queryExecutor is injectable and ensureVoucherGrantTable only calls
// assertSchemaRequirements, so the true WHERE clause can be captured without a DB.

const UPGRADED_PREDICATE = 'u.currentaccttype <> u.accttype';
const CURRENT_TIER_NOT_EXISTS = /NOT EXISTS \(\s*SELECT 1 FROM voucherstab v\s+WHERE v\.uid = u\.uid\s+AND v\.package_type/;
const ANY_VOUCHER_NOT_EXISTS = 'NOT EXISTS (SELECT 1 FROM voucherstab v WHERE v.uid = u.uid)';
const ANY_VOUCHER_EXISTS = 'EXISTS (SELECT 1 FROM voucherstab v WHERE v.uid = u.uid)';

function loadVoucherServiceForList() {
  const servicePath = path.join(repoRoot, 'services', 'voucher.js');
  delete require.cache[servicePath];
  return withStubbedModules({
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: async () => [[]], getConnection: async () => ({}) },
    },
    [path.join(repoRoot, 'services', 'schemaReadiness.js')]: {
      SCHEMA_REQUIREMENTS: { VOUCHER_GRANTS: 'VOUCHER_GRANTS' },
      assertSchemaRequirements: async () => {},
      assertSchemaReadyOnce: async () => {},
    },
  }, () => require(servicePath));
}

function makeCapturingExecutor({ dataRows = [], voucherRows = [] } = {}) {
  const sqls = [];
  return {
    sqls,
    get dataSql() { return sqls.find((s) => /AS is_upgraded/i.test(s))  || ''; },
    get whereSql() { return sqls.find((s) => /COUNT\(\*\) AS total/i.test(s)) || ''; },
    async query(sql) {
      sqls.push(sql);
      if (/COUNT\(\*\) AS total/i.test(sql)) return [[{ total: dataRows.length }]];
      if (/FROM voucherstab\s+WHERE uid IN/i.test(sql)) return [voucherRows];
      return [dataRows];
    },
  };
}

async function listWithView(view, opts = {}) {
  const { listVoucherGrantCandidates } = loadVoucherServiceForList();
  const executor = makeCapturingExecutor(opts);
  const result = await listVoucherGrantCandidates({ view, queryExecutor: executor, ...opts.args });
  return { result, executor, where: executor.whereSql };
}

test('needs_voucher (default view) excludes a current-tier voucher but is NOT upgraded-only', async () => {
  // Policy 2026-08-07: any member may be granted, so the default view is "missing a
  // voucher for their current package", not "upgraded AND missing".
  const { where } = await listWithView(undefined);
  assert.match(where, CURRENT_TIER_NOT_EXISTS, 'must exclude an existing current-tier voucher');
  assert.ok(!where.includes(UPGRADED_PREDICATE),
    'the upgraded-only restriction was removed from grantability — it is a view choice now');
});

test('upgraded_needs_voucher narrows to the targeted backfill set (both predicates)', async () => {
  const { where } = await listWithView('upgraded_needs_voucher');
  assert.ok(where.includes(UPGRADED_PREDICATE), 'must narrow to members whose package changed');
  assert.match(where, CURRENT_TIER_NOT_EXISTS, 'and who lack a current-tier voucher');
});

test('no_voucher view lists members with no voucher at all and is NOT upgraded-filtered', async () => {
  const { where } = await listWithView('no_voucher');
  assert.ok(where.includes(ANY_VOUCHER_NOT_EXISTS), 'must filter to members with no voucher row');
  assert.ok(!where.includes(UPGRADED_PREDICATE),
    'no_voucher is a LOOKUP view — it must not hide non-upgraded members');
});

test('has_voucher view lists members holding a voucher', async () => {
  const { where } = await listWithView('has_voucher');
  assert.ok(where.includes(ANY_VOUCHER_EXISTS));
  assert.ok(!where.includes(UPGRADED_PREDICATE));
});

test('all view and the cashier includeAll lookup apply no voucher/upgrade filter at all', async () => {
  const { where: allWhere } = await listWithView('all');
  assert.ok(!allWhere.includes(UPGRADED_PREDICATE));
  assert.ok(!allWhere.includes(ANY_VOUCHER_NOT_EXISTS));

  // includeAll must keep meaning "show everyone" — the cashier lookup depends on it.
  const { where: cashierWhere } = await listWithView(undefined, { args: { includeAll: true } });
  assert.ok(!cashierWhere.includes(UPGRADED_PREDICATE),
    'includeAll is the cashier member+voucher lookup and must list every member');
});

test('an unrecognised view falls back to needs_voucher, never to `all`', async () => {
  for (const bogus of ['everyone', '', 'ALL; DROP', null, 42]) {
    const { where } = await listWithView(bogus);
    assert.match(where, CURRENT_TIER_NOT_EXISTS,
      `view=${JSON.stringify(bogus)} must fall back to needs_voucher, not list everyone`);
  }
});

test('grantable mirrors the ONLY POST /grant refusal: already has a voucher for the current tier', async () => {
  const dataRows = [
    { uid: 1, currentaccttype: 20, accttype: 10, username: 'upgraded', is_upgraded: 1, has_current_tier_voucher: 0 },
    { uid: 2, currentaccttype: 10, accttype: 10, username: 'legacy', is_upgraded: 0, has_current_tier_voucher: 0 },
    { uid: 3, currentaccttype: 20, accttype: 10, username: 'alreadyGranted', is_upgraded: 1, has_current_tier_voucher: 1 },
    { uid: 4, currentaccttype: 10, accttype: 10, username: 'legacyAlreadyGranted', is_upgraded: 0, has_current_tier_voucher: 1 },
  ];
  const { result } = await listWithView('all', { dataRows });
  const byName = Object.fromEntries(result.users.map((u) => [u.username, u]));

  assert.equal(byName.upgraded.grantable, true);
  assert.equal(byName.upgraded.notGrantableReason, null);

  // POLICY 2026-08-07: never upgrading is NOT a refusal any more.
  assert.equal(byName.legacy.grantable, true, 'a never-upgraded member is grantable');
  assert.equal(byName.legacy.notGrantableReason, null);
  assert.equal(byName.legacy.isUpgraded, false, 'but is still reported as not upgraded, for display');

  // The one refusal that remains, and it is independent of upgrade status.
  assert.equal(byName.alreadyGranted.grantable, false);
  assert.equal(byName.alreadyGranted.notGrantableReason, 'already_has_voucher_for_current_tier');
  assert.equal(byName.legacyAlreadyGranted.grantable, false);
  assert.equal(byName.legacyAlreadyGranted.notGrantableReason, 'already_has_voucher_for_current_tier');
});

test('REGRESSION: an upgraded member holding a SPENT lower-tier voucher stays grantable', async () => {
  // The SeniorDelia case. Voucher rows are now fetched for every view, so hasVoucher
  // is TRUE for her — if selection ever keys on hasVoucher instead of grantable, the
  // checkbox disables on exactly the member this feature exists to serve.
  const dataRows = [
    { uid: 77, currentaccttype: 20, accttype: 10, username: 'SeniorDelia', is_upgraded: 1, has_current_tier_voucher: 0 },
  ];
  const voucherRows = [{ uid: 77, id: 501, remaining_balance: 0, status: 3 }];
  const { result } = await listWithView('needs_voucher', { dataRows, voucherRows });
  const row = result.users[0];

  assert.equal(row.hasVoucher, true, 'she does hold a (spent, lower-tier) voucher');
  assert.equal(row.grantable, true, 'and she must still be grantable for her NEW tier');
  assert.equal(row.notGrantableReason, null);
});
