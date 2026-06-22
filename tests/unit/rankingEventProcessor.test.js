const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('V037 guards one ranking process and one outbox event per repurchase', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../migrations/V037__realtime_ranking_events.sql'),
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranking_event_processstab/i);
  assert.match(sql, /PRIMARY KEY \(repurchase_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranking_realtime_outboxtab/i);
  assert.match(sql, /UNIQUE KEY uq_ranking_outbox_repurchase \(repurchase_id\)/i);
  assert.match(sql, /KEY idx_ranking_outbox_pending \(status, available_at, id\)/i);
});

test('product event evaluates sponsor ancestors nearest-first and excludes purchaser', async () => {
  const { processRepurchaseRankingEvent } = require('../../services/rankingEventProcessor');
  const evaluated = [];
  const queries = [];
  const conn = {
    query: async (sql, params = []) => {
      queries.push([sql, params]);
      if (/SELECT status FROM ranking_event_processstab/i.test(sql)) return [[]];
      return [{ affectedRows: 1 }, []];
    },
  };
  const event = { repurchaseId: 501, sourceMemberUid: 10, points: 100 };
  const result = await processRepurchaseRankingEvent(conn, event, {
    getSponsorAncestors: async (uid) => uid === 10 ? [90, 80, 70] : [],
    getBinaryAncestors: async () => [],
    getCurrentRank: async () => 0,
    evaluateMember: async (uid) => {
      evaluated.push(uid);
      return { currentRank: 0 };
    },
    applyRepurchaseDelta: async () => {},
    createPublicId: () => 'event-1',
  });

  assert.deepEqual(evaluated, [90, 80, 70]);
  assert.equal(evaluated.includes(10), false);
  assert.deepEqual(result.affectedMemberUids, [90, 80, 70]);
  assert.equal(queries.some(([sql]) => /INSERT INTO ranking_realtime_outboxtab/i.test(sql)), true);
});

test('new rank cascades through binary and sponsor ancestors until stable', async () => {
  const { processRepurchaseRankingEvent } = require('../../services/rankingEventProcessor');
  const evaluated = [];
  const storedRanks = new Map([[90, 0], [44, 0], [33, 0]]);
  const conn = {
    query: async (sql) => /SELECT status FROM ranking_event_processstab/i.test(sql)
      ? [[]]
      : [{ affectedRows: 1 }, []],
  };

  await processRepurchaseRankingEvent(conn, {
    repurchaseId: 502,
    sourceMemberUid: 10,
    points: 100,
  }, {
    getSponsorAncestors: async (uid) => uid === 10 ? [90] : uid === 44 ? [33] : [],
    getBinaryAncestors: async (uid) => uid === 90 ? [44] : [],
    getCurrentRank: async (uid) => storedRanks.get(uid) || 0,
    evaluateMember: async (uid) => {
      evaluated.push(uid);
      storedRanks.set(uid, 1);
      return { currentRank: 1 };
    },
    applyRepurchaseDelta: async () => {},
    createPublicId: () => 'event-2',
  });

  assert.deepEqual(evaluated, [90, 44, 33]);
});

test('new global consumption refreshes every ancestor of consumed source events', async () => {
  const { processRepurchaseRankingEvent } = require('../../services/rankingEventProcessor');
  const evaluated = [];
  const conn = {
    query: async (sql) => /SELECT status FROM ranking_event_processstab/i.test(sql)
      ? [[]]
      : [{ affectedRows: 1 }, []],
  };
  await processRepurchaseRankingEvent(conn, {
    repurchaseId: 504,
    sourceMemberUid: 10,
    points: 100,
  }, {
    getSponsorAncestors: async (uid) => uid === 10 ? [90] : uid === 77 ? [66, 55] : [],
    getBinaryAncestors: async () => [],
    getCurrentRank: async () => 0,
    evaluateMember: async (uid) => {
      evaluated.push(uid);
      return uid === 90
        ? { currentRank: 1, dependencySourceUids: [77] }
        : { currentRank: 0, dependencySourceUids: [] };
    },
    applyRepurchaseDelta: async () => {},
    createPublicId: () => 'event-4',
  });
  assert.deepEqual(evaluated, [90, 66, 55]);
});

test('completed repurchase replay does not evaluate again', async () => {
  const { processRepurchaseRankingEvent } = require('../../services/rankingEventProcessor');
  let evaluations = 0;
  const conn = {
    query: async (sql) => /SELECT status FROM ranking_event_processstab/i.test(sql)
      ? [[{ status: 'completed' }]]
      : [{ affectedRows: 1 }, []],
  };
  const result = await processRepurchaseRankingEvent(conn, {
    repurchaseId: 503,
    sourceMemberUid: 10,
    points: 100,
  }, {
    evaluateMember: async () => { evaluations += 1; },
  });

  assert.equal(result.alreadyProcessed, true);
  assert.equal(evaluations, 0);
});

test('maintenance route records pending ranking in-txn and defers the cascade past commit', () => {
  // Contract: the purchase must commit even if ranking later fails, so the in-request
  // path only (1) records a durable pending marker BEFORE commit, then (2) defers the
  // actual cascade + publish to AFTER commit (non-blocking). It must NOT acquire the
  // ranking lock or run the cascade inside the purchase transaction.
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/codes.js'), 'utf8');
  const routeStart = source.indexOf("router.post('/maintenance'");
  const routeSource = source.slice(routeStart);
  const recordAt = routeSource.indexOf('recordPendingRankingEvent');
  const commitAt = routeSource.indexOf('await conn.commit()');
  const deferAt = routeSource.indexOf('processAndPublishRankingEvent');
  assert.ok(recordAt >= 0, 'must record a durable pending ranking marker');
  assert.ok(commitAt > recordAt, 'pending marker must be recorded before commit');
  assert.ok(deferAt > commitAt, 'the ranking cascade must be deferred until after commit');
  assert.match(routeSource, /setImmediate\s*\(/, 'cascade must be deferred, non-blocking');
  // The cascade must NOT run inside the purchase transaction (no in-txn lock/processor).
  const inTxn = routeSource.slice(0, commitAt);
  assert.doesNotMatch(inTxn, /acquireRankingLock/, 'must not hold the ranking lock in the purchase txn');
  assert.doesNotMatch(inTxn, /processRepurchaseRankingEvent/, 'cascade must not run before commit');
  assert.doesNotMatch(routeSource, /refreshMemberRankSnapshot/);
});

test('recordPendingRankingEvent writes one idempotent processing marker (and skips invalid input)', async () => {
  const { recordPendingRankingEvent } = require('../../services/rankingEventProcessor');
  const calls = [];
  const conn = { query: async (sql, params) => { calls.push([sql, params]); return [{}, []]; } };
  const ok = await recordPendingRankingEvent(conn, { repurchaseId: 7, sourceMemberUid: 3, points: 45 });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /INSERT INTO ranking_event_processstab/i);
  assert.match(calls[0][0], /ON DUPLICATE KEY UPDATE/i);
  assert.deepEqual(calls[0][1].slice(0, 3), [7, 3, 45]);
  for (const bad of [{ repurchaseId: 0, sourceMemberUid: 3, points: 45 },
                     { repurchaseId: 7, sourceMemberUid: 0, points: 45 },
                     { repurchaseId: 7, sourceMemberUid: 3, points: 0 }]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await recordPendingRankingEvent(conn, bad), false);
  }
  assert.equal(calls.length, 1, 'invalid events must not write a marker');
});

test('runRankingEventInOwnTransaction never re-processes a completed marker', async () => {
  const { runRankingEventInOwnTransaction } = require('../../services/rankingEventProcessor');
  let began = false;
  let released = false;
  const conn = {
    query: async (sql) => {
      if (/FROM ranking_event_processstab WHERE repurchase_id/i.test(sql)) {
        return [[{ repurchase_id: 9, source_member_uid: 1, points: 50, status: 'completed' }]];
      }
      if (/RELEASE_LOCK/i.test(sql)) { released = true; return [[{ released: 1 }]]; }
      return [[], []];
    },
    beginTransaction: async () => { began = true; },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const result = await runRankingEventInOwnTransaction(9, { getConnection: async () => conn });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already-completed');
  assert.equal(began, false, 'must not open a transaction for an already-completed event');
  assert.equal(released, false, 'must not take/release the lock for an already-completed event');
});

test('runRankingEventInOwnTransaction skips when no marker exists', async () => {
  const { runRankingEventInOwnTransaction } = require('../../services/rankingEventProcessor');
  const conn = {
    query: async () => [[/* no marker */]],
    beginTransaction: async () => { throw new Error('should not begin'); },
    rollback: async () => {},
    release: () => {},
  };
  const result = await runRankingEventInOwnTransaction(123, { getConnection: async () => conn });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-marker');
});

test('ranking rollout scripts load guarded env and reconciliation stays read-only', () => {
  const reconcile = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/reconcile_realtime_rankings.js'),
    'utf8'
  );
  const replay = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/replay_ranking_events.js'),
    'utf8'
  );
  assert.match(reconcile, /loadBackendEnv\(\)/);
  assert.doesNotMatch(reconcile, /\b(?:INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP)\b/i);
  assert.match(replay, /--from-id/);
  assert.match(replay, /--mark-baseline-through/);
  assert.match(replay, /processRepurchaseRankingEvent/);
  assert.match(replay, /acquireRankingLock/);
});
