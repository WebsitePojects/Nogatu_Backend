const test = require('node:test');
const assert = require('node:assert/strict');

let rankingRace = {};
try {
  rankingRace = require('../../services/rankingRace');
} catch {
  rankingRace = {};
}

const FULL_RANK_DEFINITIONS = [
  { rank: 1, rank_code: 'supervisor_1', rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0, cash_incentive: 5000, sort_order: 1 },
  { rank: 2, rank_code: 'supervisor_2', rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1, cash_incentive: 10000, sort_order: 2 },
  { rank: 3, rank_code: 'supervisor_3', rank_name: 'Supervisor 3', points_required: 40000, left_rank_required: 2, right_rank_required: 2, cash_incentive: 20000, sort_order: 3 },
];

test('ranking race service exports the approved engine entry points', () => {
  assert.equal(typeof rankingRace.listRankableEventsForMember, 'function');
  assert.equal(typeof rankingRace.consumePointsForRank, 'function');
  assert.equal(typeof rankingRace.computeRankAwardsFromEvents, 'function');
  assert.equal(typeof rankingRace.summarizeAchievementStatus, 'function');
});

test('sponsor-tree ranking normalizes all eligible product events to unilevel ownership', async () => {
  const fakeConn = {
    async query() {
      return [[
        {
          repurchase_id: 11,
          source_member_uid: 9001,
          owner_uid: 9001,
          source_leg: 'self',
          points: 50,
          source_event_ts: '2026-05-01 10:00:00',
        },
        {
          repurchase_id: 12,
          source_member_uid: 9100,
          owner_uid: 9001,
          source_leg: 'left',
          points: 250,
          source_event_ts: '2026-05-02 10:00:00',
        },
        {
          repurchase_id: 13,
          source_member_uid: 9200,
          owner_uid: 9001,
          source_leg: 'right',
          points: 500,
          source_event_ts: '2026-05-03 10:00:00',
        },
      ]];
    },
  };

  const events = await rankingRace.listRankableEventsForMember(9001, fakeConn);
  assert.deepEqual(events.map((row) => row.sourceLeg), ['unilevel', 'unilevel', 'unilevel']);
  assert.deepEqual(events.map((row) => row.points), [50, 250, 500]);
});

test('consumePointsForRank consumes only the exact minimum points needed for the rank', () => {
  const outcome = rankingRace.consumePointsForRank([
    { sourceEventId: 1, sourceMemberUid: 11, sourceLeg: 'left', sourceEventTs: '2026-05-01 10:00:00', remainingPoints: 4000 },
    { sourceEventId: 2, sourceMemberUid: 12, sourceLeg: 'right', sourceEventTs: '2026-05-02 10:00:00', remainingPoints: 4000 },
    { sourceEventId: 3, sourceMemberUid: 13, sourceLeg: 'left', sourceEventTs: '2026-05-03 10:00:00', remainingPoints: 2500 },
  ], 10000);

  assert.equal(outcome.consumedPoints, 10000);
  assert.equal(outcome.lastConsumedEventTs, '2026-05-03 10:00:00');
  assert.deepEqual(outcome.consumptionRows.map((row) => row.pointsConsumed), [4000, 4000, 2000]);
  assert.deepEqual(outcome.remainingEvents.map((row) => row.remainingPoints), [0, 0, 500]);
});

test('computeRankAwardsFromEvents awards Supervisor 1 at 10,000 points and carries remaining points forward', () => {
  const outcome = rankingRace.computeRankAwardsFromEvents({
    memberUid: 9001,
    rankDefinitions: FULL_RANK_DEFINITIONS,
    rankableEvents: [
      { sourceEventId: 1, sourceMemberUid: 11, sourceLeg: 'left', sourceEventTs: '2026-05-01 10:00:00', remainingPoints: 5000 },
      { sourceEventId: 2, sourceMemberUid: 12, sourceLeg: 'right', sourceEventTs: '2026-05-02 10:00:00', remainingPoints: 5000 },
      { sourceEventId: 3, sourceMemberUid: 13, sourceLeg: 'left', sourceEventTs: '2026-05-03 10:00:00', remainingPoints: 500 },
    ],
    subtreeQualifiedRankCounts: {},
    existingAchievements: [],
  });

  assert.equal(outcome.awards.length, 1);
  assert.equal(outcome.awards[0].rank, 1);
  assert.equal(outcome.grossRankablePoints, 10500);
  assert.equal(outcome.consumedPoints, 10000);
  assert.equal(outcome.remainingRankablePoints, 500);
});

test('computeRankAwardsFromEvents requires fresh remaining points and left/right qualified ranks for Supervisor 2', () => {
  const noStructure = rankingRace.computeRankAwardsFromEvents({
    memberUid: 9001,
    rankDefinitions: FULL_RANK_DEFINITIONS,
    rankableEvents: [
      { sourceEventId: 1, sourceMemberUid: 11, sourceLeg: 'left', sourceEventTs: '2026-05-01 10:00:00', remainingPoints: 10000 },
      { sourceEventId: 2, sourceMemberUid: 12, sourceLeg: 'right', sourceEventTs: '2026-05-02 10:00:00', remainingPoints: 20000 },
    ],
    subtreeQualifiedRankCounts: {},
    existingAchievements: [],
  });

  assert.equal(noStructure.currentRank, 1);
  assert.equal(noStructure.remainingRankablePoints, 20000);

  const withStructure = rankingRace.computeRankAwardsFromEvents({
    memberUid: 9001,
    rankDefinitions: FULL_RANK_DEFINITIONS,
    rankableEvents: [
      { sourceEventId: 1, sourceMemberUid: 11, sourceLeg: 'left', sourceEventTs: '2026-05-01 10:00:00', remainingPoints: 10000 },
      { sourceEventId: 2, sourceMemberUid: 12, sourceLeg: 'right', sourceEventTs: '2026-05-02 10:00:00', remainingPoints: 20000 },
      { sourceEventId: 3, sourceMemberUid: 13, sourceLeg: 'right', sourceEventTs: '2026-05-03 10:00:00', remainingPoints: 5000 },
    ],
    subtreeQualifiedRankCounts: {
      2: { leftQualifiedCount: 1, rightQualifiedCount: 1 },
    },
    existingAchievements: [],
  });

  assert.equal(withStructure.currentRank, 2);
  assert.equal(withStructure.consumedPoints, 30000);
  assert.equal(withStructure.remainingRankablePoints, 5000);
});

test('summarizeAchievementStatus exposes only unfulfilled ranks as admin-claimable', () => {
  const summary = rankingRace.summarizeAchievementStatus([
    { rank: 1, achievementStatus: 'fulfilled', cashIncentive: 5000 },
    { rank: 2, achievementStatus: 'pending_fulfillment', cashIncentive: 10000 },
  ]);

  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.nextPendingRank.rank, 2);
  assert.equal(summary.nextPendingRank.cashIncentive, 10000);
});

test('computeDisplayBasis is exported', () => {
  assert.equal(typeof rankingRace.computeDisplayBasis, 'function');
});

test('computeDisplayBasis: ranked member no longer shows REMAINING=0 (own consumption not double-subtracted)', () => {
  // Jervy01 case: live downline 13,690; 10,000 consumed (all PRIOR rebuilds, so
  // already in global → event pool gross is the net 3,690). Must surface 3,690 left.
  const { displayGross, displayRemaining } = rankingRace.computeDisplayBasis({
    grossRankablePoints: 3690, consumedPoints: 10000, newConsumedPoints: 0,
  });
  assert.equal(displayGross, 13690);
  assert.equal(displayRemaining, 3690);
});

test('computeDisplayBasis: unconsumed member is unchanged', () => {
  const r = rankingRace.computeDisplayBasis({ grossRankablePoints: 9460, consumedPoints: 0, newConsumedPoints: 0 });
  assert.equal(r.displayGross, 9460);
  assert.equal(r.displayRemaining, 9460);
});

test('computeDisplayBasis: rank achieved THIS rebuild is not added back (new consumption stays excluded)', () => {
  // rawDownline 12,000, no prior consumption; this rebuild consumes 10,000 for the rank.
  const r = rankingRace.computeDisplayBasis({ grossRankablePoints: 12000, consumedPoints: 10000, newConsumedPoints: 10000 });
  assert.equal(r.displayGross, 12000);
  assert.equal(r.displayRemaining, 2000);
});

test('computeDisplayBasis: mixed prior + new consumption stays internally consistent (GROSS - CONSUMED = REMAINING)', () => {
  // 10,000 prior (in global, netted out of gross 3,000) + 2,000 new this rebuild.
  const r = rankingRace.computeDisplayBasis({ grossRankablePoints: 3000, consumedPoints: 12000, newConsumedPoints: 2000 });
  assert.equal(r.displayGross, 13000);
  assert.equal(r.displayRemaining, 1000);
  assert.equal(r.displayGross - 12000, r.displayRemaining);
});

test('computeDisplayBasis: coerces strings and defaults missing fields, never negative', () => {
  assert.deepEqual(rankingRace.computeDisplayBasis({ grossRankablePoints: '3690', consumedPoints: '10000' }),
    { displayGross: 13690, displayRemaining: 3690 });
  assert.deepEqual(rankingRace.computeDisplayBasis({}), { displayGross: 0, displayRemaining: 0 });
});
