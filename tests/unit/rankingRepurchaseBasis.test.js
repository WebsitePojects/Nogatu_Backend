const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RANKING_BASIS_LABEL,
  getRankCashIncentive,
  getPackageRankingPolicy,
  filterRankDefinitionsForPackage,
  canReleaseRankAchievementForPackage,
  normalizeRankDefinitions,
  sumRepurchasePoints,
} = require('../../services/ranking');

test('ranking basis label is repurchase points', () => {
  assert.equal(RANKING_BASIS_LABEL, 'Repurchase points');
});

test('ranking basis sums repurchase incentivepoints1 values', () => {
  const total = sumRepurchasePoints([
    { incentivepoints1: 50 },
    { incentivepoints1: '45' },
    { incentivepoints1: null },
    { incentivepoints1: 100 },
  ]);

  assert.equal(total, 195);
});

test('ranking cash incentive falls back to approved supervisor amounts', async () => {
  const missingDefinitionConn = {
    query: async () => {
      const err = new Error('missing rank definitions');
      err.code = 'ER_NO_SUCH_TABLE';
      throw err;
    },
  };

  assert.equal(await getRankCashIncentive(1, missingDefinitionConn), 5000);
  assert.equal(await getRankCashIncentive(2, missingDefinitionConn), 10000);
  assert.equal(await getRankCashIncentive(3, missingDefinitionConn), 20000);
});

test('rank definitions normalize left/right requirements from rank codes', () => {
  const normalized = normalizeRankDefinitions([
    {
      rank_code: 'supervisor_1',
      rank_name: 'Supervisor 1',
      points_required: '10000.00',
      left_rank_required: null,
      right_rank_required: null,
      sort_order: 10,
    },
    {
      rank_code: 'supervisor_2',
      rank_name: 'Supervisor 2',
      points_required: '20000.00',
      left_rank_required: 'supervisor_1',
      right_rank_required: 'supervisor_1',
      sort_order: 20,
    },
    {
      rank_code: 'manager_1',
      rank_name: 'Manager 1',
      points_required: '60000.00',
      left_rank_required: 'supervisor_3',
      right_rank_required: 'supervisor_3',
      sort_order: 40,
    },
  ]);

  assert.equal(normalized[0].rank, 1);
  assert.equal(normalized[0].left_rank_required, 0);
  assert.equal(normalized[1].rank, 2);
  assert.equal(normalized[1].left_rank_required, 1);
  assert.equal(normalized[1].right_rank_required, 1);
  assert.equal(normalized[2].rank, 3);
  assert.equal(normalized[2].left_rank_required, 0);
});

test('package ranking policy excludes Bronze and Silver and gates higher packages', () => {
  assert.deepEqual(
    getPackageRankingPolicy(10),
    {
      packageType: 10,
      packageLabel: 'Bronze',
      rankingEligible: false,
      maxRank: 0,
      maxRankLabel: null,
      nextUpgradePackageType: 30,
      nextUpgradePackageLabel: 'Gold',
      reason: 'Upgrade to Gold package to begin ranking.',
    }
  );

  assert.deepEqual(
    getPackageRankingPolicy(30),
    {
      packageType: 30,
      packageLabel: 'Gold',
      rankingEligible: true,
      maxRank: 3,
      maxRankLabel: 'Supervisor 3',
      nextUpgradePackageType: 40,
      nextUpgradePackageLabel: 'Platinum',
      reason: 'Upgrade to Platinum package to progress beyond Supervisor 3.',
    }
  );
});

test('rank definitions are filtered by package ceiling', () => {
  const definitions = [
    { rank: 1, rank_name: 'Supervisor 1' },
    { rank: 2, rank_name: 'Supervisor 2' },
    { rank: 3, rank_name: 'Supervisor 3' },
    { rank: 4, rank_name: 'Manager 1' },
  ];

  assert.deepEqual(
    filterRankDefinitionsForPackage(definitions, 10).map((row) => row.rank),
    []
  );

  assert.deepEqual(
    filterRankDefinitionsForPackage(definitions, 30).map((row) => row.rank),
    [1, 2, 3]
  );
});

test('rank achievement release respects the current package gate', () => {
  assert.equal(canReleaseRankAchievementForPackage(30, 3), true);
  assert.equal(canReleaseRankAchievementForPackage(30, 4), false);
  assert.equal(canReleaseRankAchievementForPackage(10, 1), false);
  assert.equal(canReleaseRankAchievementForPackage(50, 10), true);
});
