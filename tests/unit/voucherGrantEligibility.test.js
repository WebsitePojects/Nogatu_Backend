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

// ── Upgraded-only policy ─────────────────────────────────────────────────
// The manual grant exists to fix members whose PACKAGE changed without a
// matching voucher. Measured on prod 2026-08-07, dropping this gate exposes
// 7,176 pre-launch legacy members = ₱40,755,000 of redeemable value.

test('a never-upgraded (legacy) member is refused with not_upgraded and NO voucher is issued', async () => {
  const scenarios = {
    // joinedTier === currentTier -> registered Bronze, still Bronze, never upgraded.
    601: { eligible: true, currentTier: 10, joinedTier: 10, amount: 2500 },
  };
  const { router, connectionsLog, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const req = { body: { uids: [601] }, session: { adminid: 1 } };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.granted, 0);
  assert.deepEqual(res.body.results, [
    { uid: 601, granted: false, reason: 'not_upgraded', amount: 2500 },
  ]);
  // The money assertion: the issue helper must never have been reached.
  assert.deepEqual(voucherServiceStub.issueCalls, []);
  // connectionsLog entries ARE the event arrays (see makePoolStub).
  assert.ok(connectionsLog[0].includes('rollback'), 'a refused uid must roll back, never commit');
  assert.ok(!connectionsLog[0].includes('commit'));
});

test('the upgraded-only refusal happens even though eligibility itself says eligible', async () => {
  // Guards against someone "simplifying" the route by trusting eligible alone.
  const scenarios = { 602: { eligible: true, reason: 'eligible', currentTier: 60, joinedTier: 60, amount: 150000 } };
  const { router, voucherServiceStub } = loadVoucherManagementRouterForGrant({ scenarios });
  const handlers = getMatchingHandlers(router, 'post', '/grant');
  const res = createResponse();

  await runHandlers(handlers, { body: { uids: [602] }, session: { adminid: 1 } }, res);

  assert.equal(res.body.results[0].reason, 'not_upgraded');
  assert.deepEqual(voucherServiceStub.issueCalls, [], 'a Diamond legacy member must not receive ₱150,000');
});

test('an upgraded member is still granted normally (the policy is not a blanket block)', async () => {
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

test('the candidate list is upgraded-only in grant mode, but NOT in the cashier includeAll lookup', () => {
  const serviceSrc = fs.readFileSync(path.join(repoRoot, 'services', 'voucher.js'), 'utf8');
  const start = serviceSrc.indexOf('async function listVoucherGrantCandidates');
  assert.ok(start > -1, 'listVoucherGrantCandidates must exist');
  const slice = serviceSrc.slice(start, start + 3000);

  const guardIdx = slice.indexOf('if (!safeIncludeAll)');
  const predicateIdx = slice.indexOf("u.currentaccttype <> u.accttype");
  assert.ok(guardIdx > -1, 'the includeAll guard must exist');
  assert.ok(predicateIdx > -1, 'the upgraded-only predicate must exist');
  assert.ok(predicateIdx > guardIdx,
    'the upgraded-only predicate must sit INSIDE if (!safeIncludeAll) — includeAll is the '
    + "cashier's member+voucher lookup (VoucherGrant.jsx) and must keep listing every member");
});
