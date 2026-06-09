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
    currentaccttype: 30,
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
  assert.equal(snapshot.rankingEligible, true);
  assert.equal(snapshot.packageRankMax, 10);
});

test('stored ranking snapshots keep Bronze accounts on their earned rank when all ranks are unlocked', () => {
  const definitions = [
    { rank: 1, rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0 },
    { rank: 2, rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1 },
  ];

  const snapshot = buildSnapshotFromStoredRow({
    uid: 88,
    currentaccttype: 10,
    current_rank: 2,
    highest_rank_no: 2,
    rank_level: 2,
    basis_points: 25000,
    consumed_points: 20000,
    remaining_rankable_points: 5000,
    basis_label: 'Repurchase points',
    left_qualified_count: 1,
    right_qualified_count: 1,
    pending_achievement_count: 1,
    incentive_status: 0,
    reward_status: 0,
    rank_date: '2026-05-15 08:00:00',
  }, definitions, {
    binaryPoints: 0,
    leftCount: 0,
    rightCount: 0,
    leftPoints: 0,
    rightPoints: 0,
  });

  assert.equal(snapshot.currentRank, 2);
  assert.equal(snapshot.currentRankLabel, 'Supervisor 2');
  assert.equal(snapshot.rankingEligible, true);
  assert.equal(snapshot.blockedByPackageGate, false);
  assert.equal(snapshot.rankingEligibilityReason, null);
});

test('stored ranking snapshots do not stop Gold members at a package ceiling anymore', () => {
  const definitions = [
    { rank: 1, rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0 },
    { rank: 2, rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1 },
    { rank: 3, rank_name: 'Supervisor 3', points_required: 40000, left_rank_required: 2, right_rank_required: 2 },
    { rank: 4, rank_name: 'Manager 1', points_required: 60000, left_rank_required: 3, right_rank_required: 3 },
  ];

  const snapshot = buildSnapshotFromStoredRow({
    uid: 99,
    currentaccttype: 30,
    current_rank: 3,
    highest_rank_no: 3,
    rank_level: 3,
    basis_points: 60000,
    consumed_points: 40000,
    remaining_rankable_points: 20000,
    basis_label: 'Repurchase points',
    left_qualified_count: 1,
    right_qualified_count: 1,
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

  assert.equal(snapshot.currentRank, 3);
  assert.equal(snapshot.nextRank, 4);
  assert.equal(snapshot.blockedByPackageGate, false);
  assert.equal(snapshot.upgradeRequiredPackageLabel, null);
  assert.equal(snapshot.rankingEligibilityReason, null);
});

test('stored ranking snapshots normalize next-rank requirement fields for the member UI', () => {
  const snapshot = buildSnapshotFromStoredRow({
    uid: 111,
    currentaccttype: 40,
    current_rank: 0,
    highest_rank_no: 0,
    rank_level: 0,
    basis_points: 0,
    consumed_points: 0,
    remaining_rankable_points: 0,
    basis_label: 'Repurchase points',
    left_qualified_count: 0,
    right_qualified_count: 0,
    pending_achievement_count: 0,
    incentive_status: 0,
    reward_status: 0,
    rank_date: '2026-05-15 08:00:00',
  }, definitions, {
    binaryPoints: 0,
    leftCount: 0,
    rightCount: 0,
    leftPoints: 0,
    rightPoints: 0,
  });

  assert.equal(snapshot.nextRankRequirement.rankName, 'Supervisor 1');
  assert.equal(snapshot.nextRankRequirement.pointsRequired, 10000);
  assert.equal(snapshot.nextRankRequirement.leftRankRequired, 0);
  assert.equal(snapshot.nextRankRequirement.rightRankRequired, 0);
});
