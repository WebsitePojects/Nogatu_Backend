const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldRefreshRankState,
  buildSnapshotFromStoredRow,
} = require('../../services/ranking');

const definitions = [
  { rank: 1, rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0 },
  { rank: 2, rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1 },
];

test('fresh ranking snapshots do not require recomputation', () => {
  const row = {
    uid: 77,
    current_rank: 1,
    highest_rank_no: 1,
    rank_level: 1,
    last_calculated_at: new Date().toISOString(),
    rank_date: '2026-05-15 08:00:00',
  };

  assert.equal(shouldRefreshRankState(row), false);
});

test('stale ranking snapshots require recomputation', () => {
  const stale = new Date(Date.now() - (16 * 60 * 1000)).toISOString();
  const row = {
    uid: 77,
    current_rank: 1,
    highest_rank_no: 1,
    rank_level: 1,
    last_calculated_at: stale,
    rank_date: '2026-05-15 08:00:00',
  };

  assert.equal(shouldRefreshRankState(row), true);
});

test('stored ranking snapshots derive next-rank gate without full rebuild', () => {
  const snapshot = buildSnapshotFromStoredRow({
    uid: 77,
    current_rank: 1,
    highest_rank_no: 1,
    rank_level: 1,
    basis_points: 18500,
    consumed_points: 10000,
    remaining_rankable_points: 8500,
    basis_label: 'Repurchase points',
    left_qualified_count: 1,
    right_qualified_count: 0,
    pending_achievement_count: 0,
    incentive_status: 1,
    reward_status: 1,
    rank_date: '2026-05-15 08:00:00',
  }, definitions, {
    binaryPoints: 0,
    leftCount: 0,
    rightCount: 0,
    leftPoints: 0,
    rightPoints: 0,
  });

  assert.equal(snapshot.currentRank, 1);
  assert.equal(snapshot.nextRank, 2);
  assert.equal(snapshot.leftRequirementMet, true);
  assert.equal(snapshot.rightRequirementMet, false);
});
