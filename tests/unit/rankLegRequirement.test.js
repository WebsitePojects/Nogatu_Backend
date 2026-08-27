/**
 * Both-legs rank gate (regression found 2026-08-27 while proving RonaldL01's Supervisor 2).
 *
 * computeRankAwardsFromEvents() gated the leg requirement with `leftQualifiedCount > 0`
 * instead of `>= left_rank_required`. Supervisor 2 requires 1 qualified downline per leg,
 * so `> 0` was accidentally equivalent there — but Supervisor 3 requires 2, Manager 1
 * requires 3, and every one of them would have been awarded off a SINGLE qualified
 * downline per leg. Supervisor 3 alone carries PHP 20,000 + international travel.
 *
 * The display path already used `>= required`, so the award gate and the progress UI
 * disagreed for every rank above 2.
 */
const test = require('node:test');
const assert = require('node:assert');

const { computeRankAwardsFromEvents } = require('../../services/rankingRace');

// Real thresholds from FULL_RANK_DEFINITIONS / rank_definitionstab.
const DEFS = [
  { rank: 1, rank_code: 'supervisor_1', rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0, sort_order: 10 },
  { rank: 2, rank_code: 'supervisor_2', rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1, sort_order: 20 },
  { rank: 3, rank_code: 'supervisor_3', rank_name: 'Supervisor 3', points_required: 40000, left_rank_required: 2, right_rank_required: 2, sort_order: 30 },
];

// Plenty of points so the ONLY thing under test is the leg gate.
function events(total, chunk = 1000) {
  const out = [];
  for (let i = 0; i < total / chunk; i += 1) {
    out.push({
      sourceEventId: i + 1,
      sourceMemberUid: 900000 + i,
      sourceLeg: 'unilevel',
      sourceDepth: 1,
      points: chunk,
      remainingPoints: chunk,
      sourceEventTs: new Date(2026, 7, 1 + (i % 25), 9, 0, 0),
    });
  }
  return out;
}

const counts = (left, right) => ({
  1: { leftQualifiedCount: left, rightQualifiedCount: right },
  2: { leftQualifiedCount: left, rightQualifiedCount: right },
  3: { leftQualifiedCount: left, rightQualifiedCount: right },
});

function awardedRanks({ left, right, points = 200000 }) {
  const state = computeRankAwardsFromEvents({
    memberUid: 1,
    rankDefinitions: DEFS,
    rankableEvents: events(points),
    subtreeQualifiedRankCounts: counts(left, right),
    existingAchievements: [],
  });
  return state.awards.map((a) => a.rank);
}

test('rank 1 needs no qualified legs (left_rank_required = 0)', () => {
  assert.deepEqual(awardedRanks({ left: 0, right: 0 }), [1]);
});

test('rank 2 needs 1 per leg - one leg empty blocks it', () => {
  assert.deepEqual(awardedRanks({ left: 1, right: 0 }), [1]);
  assert.deepEqual(awardedRanks({ left: 0, right: 1 }), [1]);
});

test('rank 2 is awarded with exactly 1 per leg (RonaldL01: left 1, right 3)', () => {
  assert.deepEqual(awardedRanks({ left: 1, right: 1 }), [1, 2]);
  assert.deepEqual(awardedRanks({ left: 1, right: 3 }), [1, 2]);
});

test('REGRESSION: rank 3 requires 2 per leg and must NOT be awarded on 1', () => {
  // The pre-fix `> 0` gate awarded Supervisor 3 here. PHP 20,000 + international travel.
  assert.deepEqual(awardedRanks({ left: 1, right: 1 }), [1, 2],
    'Supervisor 3 was awarded with only 1 qualified downline per leg');
});

test('rank 3 IS awarded once both legs actually reach 2', () => {
  assert.deepEqual(awardedRanks({ left: 2, right: 2 }), [1, 2, 3]);
});

test('rank 3 blocked when only ONE leg reaches 2', () => {
  assert.deepEqual(awardedRanks({ left: 2, right: 1 }), [1, 2]);
  assert.deepEqual(awardedRanks({ left: 1, right: 2 }), [1, 2]);
});

test('the leg gate is independent of points - full legs still need the points', () => {
  // Ranks consume SEQUENTIALLY: rank 1 takes 10,000 and rank 2 takes 20,000, so 35,000
  // funds both and leaves 5,000 - far short of the 40,000 rank 3 requires. Qualified legs
  // alone must never award a rank.
  assert.deepEqual(awardedRanks({ left: 2, right: 2, points: 35000 }), [1, 2]);
  // And with only 25,000 there is not even enough left for rank 2 (15,000 < 20,000).
  assert.deepEqual(awardedRanks({ left: 2, right: 2, points: 25000 }), [1]);
});
