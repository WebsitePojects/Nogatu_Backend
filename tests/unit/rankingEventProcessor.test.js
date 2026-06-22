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

test('maintenance route processes ranking before commit and removes background refresh', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/codes.js'), 'utf8');
  const routeStart = source.indexOf("router.post('/maintenance'");
  const routeSource = source.slice(routeStart);
  const processAt = routeSource.indexOf('processRepurchaseRankingEvent');
  const commitAt = routeSource.indexOf('await conn.commit()');
  const flushAt = routeSource.indexOf('flushRankingOutboxForRepurchase');
  assert.ok(processAt >= 0, 'ranking processor must be called');
  assert.ok(commitAt > processAt, 'ranking processor must finish before commit');
  assert.ok(flushAt > commitAt, 'outbox must publish only after commit');
  assert.doesNotMatch(routeSource, /setImmediate\s*\(/);
  assert.doesNotMatch(routeSource, /refreshMemberRankSnapshot/);
});
