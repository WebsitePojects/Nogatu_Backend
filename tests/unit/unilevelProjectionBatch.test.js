'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { getLeadershipTraceability } = require('../../services/income/leadership');

// ── require.cache injection pattern (mirrors tests/unit/pairingUpgradeTotals.test.js) ──
// unilevel.js hard-codes `pool.query(...)` at module scope (no injectable `conn` param), so
// the only way to drive it against a fixture instead of a real MySQL connection is to swap
// out `config/database`'s cached module.exports BEFORE requiring services/income/unilevel.js.
function loadUnilevel(queryImpl) {
  const unilevelPath = require.resolve('../../services/income/unilevel');
  const databasePath = require.resolve('../../config/database');

  delete require.cache[unilevelPath];
  delete require.cache[databasePath];

  require.cache[databasePath] = {
    exports: { pool: { query: queryImpl } },
  };

  return require(unilevelPath);
}

// ── Shared fixture query router ──────────────────────────────────────────────────────────
// Handles every SQL shape used by BOTH the old per-node recursive path
// (calculateUnilevelForWindow -> calculateUnilevel -> getTotalPointsForRange) and the new
// batched BFS path (calculateUnilevelProjection -> calculateUnilevelPointsByLevelBatched ->
// getTotalPointsForRangeBatch), driven off the same plain-object fixture so both paths are
// proven equivalent against the SAME underlying "data".
//
//   users:  Map<uid, { uid, drefid, currentaccttype }>
//   points: Map<uid, number>  (repurchase incentivepoints1 total for the test's date window)
function makeFixtureQuery({ users, points, failBucketedRepurchase = false, onCall } = {}) {
  return async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (onCall) onCall(s, params);

    if (s.startsWith('SELECT currentaccttype FROM usertab WHERE uid = ?')) {
      const uid = Number(params[0]);
      const u = users.get(uid);
      return [[{ currentaccttype: u ? u.currentaccttype : 0 }]];
    }

    // Batched child fetch (new BFS path): SELECT uid, drefid FROM usertab WHERE drefid IN (...)
    if (s.startsWith('SELECT uid, drefid FROM usertab WHERE drefid IN')) {
      const parentIds = new Set(params.map(Number));
      const rows = [...users.values()].filter((u) => parentIds.has(Number(u.drefid)));
      return [rows.map((u) => ({ uid: u.uid, drefid: u.drefid }))];
    }

    // Per-node recursive child fetch (old path): SELECT uid FROM usertab WHERE drefid = ?
    if (s.startsWith('SELECT uid FROM usertab WHERE drefid = ?')) {
      const parentId = Number(params[0]);
      const rows = [...users.values()].filter((u) => Number(u.drefid) === parentId);
      return [rows.map((u) => ({ uid: u.uid }))];
    }

    // Batched points fetch (new BFS path): SELECT uid, SUM(incentivepoints1) ... GROUP BY uid
    if (s.startsWith('SELECT uid, SUM(incentivepoints1)')) {
      const hasBucket = s.includes('maintenance_bucket = ?');
      if (hasBucket && failBucketedRepurchase) {
        const err = new Error('Unknown column maintenance_bucket (pre-V036 fixture)');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      const uidCount = hasBucket ? params.length - 3 : params.length - 2;
      const uids = params.slice(0, uidCount).map(Number);
      const rows = uids
        .filter((u) => points.has(u))
        .map((u) => ({ uid: u, ttlpoints: points.get(u) }));
      return [rows];
    }

    // Per-uid points fetch (old path): SELECT SUM(incentivepoints1) as ttlpoints ...
    if (s.startsWith('SELECT SUM(incentivepoints1) as ttlpoints')) {
      const hasBucket = s.includes('maintenance_bucket = ?');
      if (hasBucket && failBucketedRepurchase) {
        const err = new Error('Unknown column maintenance_bucket (pre-V036 fixture)');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      const uid = Number(params[0]);
      return [[{ ttlpoints: points.get(uid) || 0 }]];
    }

    throw new Error(`Unexpected SQL in test fixture: ${s}`);
  };
}

function usersMap(rows) {
  return new Map(rows.map((r) => [Number(r.uid), r]));
}

// ── (a) batched projection == old recursive projection, incl. rollup compression ──────────
test('batched projection matches the old recursive projection on a 3-level tree (empty middle level compresses up)', async () => {
  // root(1, Gold/unilevelReach=7) -> 10 (0 pts) -> 20 (500 pts) -> 30 (300 pts)
  // Level 1 (uid 10) contributes NO points -> excluded from "qualifying" -> levels 2 and 3
  // compress up into effective level 1 (5%) and effective level 2 (3%).
  const users = usersMap([
    { uid: 1, drefid: 0, currentaccttype: 30 },
    { uid: 10, drefid: 1, currentaccttype: 10 },
    { uid: 20, drefid: 10, currentaccttype: 10 },
    { uid: 30, drefid: 20, currentaccttype: 10 },
  ]);
  const points = new Map([[20, 500], [30, 300]]); // uid 10 absent -> 0

  const oldMod = loadUnilevel(makeFixtureQuery({ users, points }));
  const oldResult = await oldMod.calculateUnilevelForWindow(1, {
    start: '2026-07-01',
    end: '2026-07-31',
    requireMaintenance: false,
    preventDuplicateCredit: false,
  });

  const newMod = loadUnilevel(makeFixtureQuery({ users, points }));
  const newResultDirect = await newMod.calculateUnilevelProjection(1, '2026-07-01', '2026-07-31');
  const newResultPublicApi = await newMod.getProjectedCurrentMonthUnilevel(1);

  const expected = 500 * 0.05 + 300 * 0.03; // effective level1 + level2
  assert.strictEqual(oldResult, expected, 'old recursive path sanity check');
  assert.strictEqual(newResultDirect, expected, 'batched path matches expected math');
  assert.strictEqual(newResultDirect, oldResult, 'batched projection == old recursive projection');
  assert.strictEqual(newResultPublicApi, oldResult, 'public getProjectedCurrentMonthUnilevel == old recursive projection');
});

// ── (b) IN-list chunking: >1000 nodes at a level must be split into <=1000-id batches ─────
test('batched projection chunks IN-lists at 1000 on both the usertab and repurchasetab queries', async () => {
  const users = usersMap([{ uid: 1, drefid: 0, currentaccttype: 60 }]); // Diamond, unilevelReach=10
  const points = new Map();

  // 1500 direct (level-1) children, 2 points each.
  for (let i = 0; i < 1500; i += 1) {
    const uid = 100000 + i;
    users.set(uid, { uid, drefid: 1, currentaccttype: 10 });
    points.set(uid, 2);
  }
  // One level-2 descendant hanging off the FIRST level-1 child, to also force chunking on the
  // usertab "drefid IN" child-fetch query at level 2 (1500 level-1 parents -> 2 chunks).
  users.set(200000, { uid: 200000, drefid: 100000, currentaccttype: 10 });
  points.set(200000, 7);

  const calls = { drefidIn: [], uidIn: [] };
  const query = makeFixtureQuery({
    users,
    points,
    onCall: (sql, params) => {
      if (sql.startsWith('SELECT uid, drefid FROM usertab WHERE drefid IN')) {
        calls.drefidIn.push(params.length);
      } else if (sql.startsWith('SELECT uid, SUM(incentivepoints1)')) {
        const hasBucket = sql.includes('maintenance_bucket = ?');
        calls.uidIn.push(hasBucket ? params.length - 3 : params.length - 2);
      }
    },
  });

  const mod = loadUnilevel(query);
  const result = await mod.calculateUnilevelProjection(1, '2026-07-01', '2026-07-31');

  // level1 = 1500 * 2 = 3000 (effective level 1, 5%); level2 = 7 (effective level 2, 3%)
  const expected = 3000 * 0.05 + 7 * 0.03;
  assert.strictEqual(result, expected);

  // Chunking actually engaged (a 1000-sized chunk appears) and never exceeded 1000.
  assert.ok(calls.drefidIn.includes(1000), `expected a 1000-sized drefid-IN chunk, got ${JSON.stringify(calls.drefidIn)}`);
  assert.ok(calls.uidIn.includes(1000), `expected a 1000-sized uid-IN chunk, got ${JSON.stringify(calls.uidIn)}`);
  assert.ok(calls.drefidIn.every((n) => n <= 1000), 'drefid IN-list must never exceed 1000');
  assert.ok(calls.uidIn.every((n) => n <= 1000), 'repurchase uid IN-list must never exceed 1000');
  // level1 fetch over 1 parent (root) = 1 call; level2 fetch over 1500 level-1 parents chunks
  // 2 ways (1000+500); level3 fetch over the single level-2 uid = 1 more call (finds nothing,
  // scan stops). Total 4 drefid-IN calls: [1, 1, 500, 1000].
  assert.deepEqual(calls.drefidIn.sort((x, y) => x - y), [1, 1, 500, 1000]);
  // repurchase points fetch only happens for level1 (1500 uids, chunks 2 ways) and level2
  // (1 uid). Total 3 calls: [1, 500, 1000].
  assert.deepEqual(calls.uidIn.sort((x, y) => x - y), [1, 500, 1000]);
});

// ── (c) cycle fixture A->B->A terminates and counts each node exactly once ────────────────
test('cycle fixture (A=100 <-> B=200): batched projection counts B once, never re-walks the cycle', async () => {
  // A(100).drefid = 200 (B); B(200).drefid = 100 (A) -- a 2-node drefid cycle.
  const users = usersMap([
    { uid: 100, drefid: 200, currentaccttype: 30 }, // Gold, unilevelReach=7
    { uid: 200, drefid: 100, currentaccttype: 10 },
  ]);
  // Give the ROOT itself high points, to prove it is never counted as its own downline.
  const points = new Map([[100, 999999], [200, 400]]);

  const mod = loadUnilevel(makeFixtureQuery({ users, points }));
  const result = await mod.calculateUnilevelProjection(100, '2026-07-01', '2026-07-31');

  // Only B's 400 points at level 1 (effective level 1, 5%). Root's own points must never
  // appear, and B must not be re-counted at level 3, 5, 7, ... via the A<->B loop.
  assert.strictEqual(result, 400 * 0.05);
});

test('cycle fixture (A=100 <-> B=200): calculateUnilevel (money path) visited-set stops the loop and counts B once', async () => {
  const users = usersMap([
    { uid: 100, drefid: 200 },
    { uid: 200, drefid: 100 },
  ]);
  const points = new Map([[100, 999999], [200, 400]]);

  const mod = loadUnilevel(makeFixtureQuery({ users, points }));
  const state = { maxReach: 7, pointsByLevel: {} };
  const getPointsForUid = (uid) => points.get(Number(uid)) || 0;

  await mod.calculateUnilevel(100, 1, state, getPointsForUid);

  // Exactly one level populated (level 1, B's 400 points). No level 2 (A re-counted), no
  // level 3/5/7... (B re-counted again) from looping the cycle.
  assert.deepEqual(state.pointsByLevel, { 1: 400 });
});

// ── acyclic sanity: cycle guard is a provable no-op on a normal (non-cyclic) tree ─────────
test('calculateUnilevel visited-set guard is a no-op on an acyclic tree (matches pre-fix shape)', async () => {
  const users = usersMap([
    { uid: 1, drefid: 0 },
    { uid: 2, drefid: 1 },
    { uid: 3, drefid: 1 },
    { uid: 4, drefid: 2 },
  ]);
  const points = new Map([[2, 100], [3, 50], [4, 25]]);

  const mod = loadUnilevel(makeFixtureQuery({ users, points }));
  const state = { maxReach: 10, pointsByLevel: {} };
  const getPointsForUid = (uid) => points.get(Number(uid)) || 0;

  await mod.calculateUnilevel(1, 1, state, getPointsForUid);

  // level1: uid2(100)+uid3(50)=150; level2: uid4(25). Each node visited exactly once already
  // in a real tree, so this is identical to what the un-guarded recursion would have produced.
  assert.deepEqual(state.pointsByLevel, { 1: 150, 2: 25 });
});

// ── ER_BAD_FIELD_ERROR fallback preserved exactly for the batched points query ────────────
test('getTotalPointsForRangeBatch falls back to the unbucketed query on ER_BAD_FIELD_ERROR (pre-V036 compat)', async () => {
  const users = usersMap([{ uid: 1, drefid: 0, currentaccttype: 30 }, { uid: 10, drefid: 1, currentaccttype: 10 }]);
  const points = new Map([[10, 250]]);

  const mod = loadUnilevel(makeFixtureQuery({ users, points, failBucketedRepurchase: true }));

  const map = await mod.getTotalPointsForRangeBatch([10], '2026-07-01', '2026-07-31', 'unilevel');
  assert.strictEqual(map.get(10), 250, 'falls back to the unbucketed query and still returns the correct total');

  // And the whole projection still computes correctly through the fallback.
  const result = await mod.calculateUnilevelProjection(1, '2026-07-01', '2026-07-31');
  assert.strictEqual(result, 250 * 0.05);
});

// ── (d) leadership self-sponsor (drefid = own uid) contributes 0 ─────────────────────────
test('leadership traceability: self-sponsor (drefid = own uid) contributes 0 bonus', async () => {
  const conn = {
    query: async (_sql, params) => {
      const parentId = Number(params[0]);
      // uid 500's own drefid is 500 -- querying "children of 500" finds 500 itself.
      if (parentId === 500) {
        return [[{ uid: 500, username: 'selfref', firstname: 'Self', lastname: 'Ref', pairingIncome: 100000, directReferralCount: 0 }]];
      }
      return [[]];
    },
  };

  const trace = await getLeadershipTraceability(500, conn);
  assert.strictEqual(trace.totalBonus, 0);
  assert.strictEqual(trace.totalSources, 0);
  assert.deepEqual(trace.rows, []);
});

// ── leadership cycle fixture A(100) <-> B(200): counts B once, never loops levels 1/3/5 ───
test('leadership traceability: cycle fixture (A=100 <-> B=200) counts B once', async () => {
  const relations = new Map([
    [100, 200], // A's parent (drefid) is B
    [200, 100], // B's parent (drefid) is A
  ]);
  const incomeByUid = new Map([[100, 999999], [200, 5000]]);

  const conn = {
    query: async (_sql, params) => {
      const parentId = Number(params[0]);
      const rows = [];
      for (const [uid, drefid] of relations) {
        if (drefid === parentId) {
          rows.push({
            uid,
            username: `u${uid}`,
            firstname: 'F',
            lastname: 'L',
            pairingIncome: incomeByUid.get(uid) || 0,
            directReferralCount: 0,
          });
        }
      }
      return [rows];
    },
  };

  const trace = await getLeadershipTraceability(100, conn);

  assert.strictEqual(trace.totalSources, 1, 'only B counted once, A must never appear as its own downline');
  assert.strictEqual(trace.rows[0].uid, 200);
  assert.strictEqual(trace.rows[0].level, 1);
  assert.strictEqual(trace.totalBonus, 5000 * 0.05);
});

// ── leadership acyclic sanity: normal 2-level tree unaffected by the visited-set guard ────
test('leadership traceability: acyclic 2-level tree is unaffected by the visited-set guard', async () => {
  const children = new Map([
    [1, [{ uid: 10, pairingIncome: 10000 }, { uid: 11, pairingIncome: 5000 }]], // level 1 under root 1
    [10, [{ uid: 20, pairingIncome: 2000 }]], // level 2 under uid 10
  ]);

  const conn = {
    query: async (_sql, params) => {
      const parentId = Number(params[0]);
      const rows = (children.get(parentId) || []).map((c) => ({
        uid: c.uid,
        username: `u${c.uid}`,
        firstname: 'F',
        lastname: 'L',
        pairingIncome: c.pairingIncome,
        directReferralCount: 0,
      }));
      return [rows];
    },
  };

  const trace = await getLeadershipTraceability(1, conn);

  assert.strictEqual(trace.totalSources, 3);
  assert.strictEqual(trace.totalBonus, 10000 * 0.05 + 5000 * 0.05 + 2000 * 0.02);
});
