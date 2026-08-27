/**
 * pendingAchievementCount clobber (found 2026-08-27 auditing RonaldL01's Supervisor 2).
 *
 * applyPackageRankingGateToSnapshot() unconditionally overwrote the caller-supplied
 * pendingAchievementCount with a value recomputed from its `achievements` argument.
 * getAllRankings() (the admin Rankings board) deliberately passes `achievements: []` --
 * loading per-member achievement rows for the whole leaderboard would be an N+1 -- and
 * instead supplies the denormalized rankingstab.pending_achievement_count.
 *
 * Result: a correct stored count of 1 or 2 was clobbered to 0, and the board's Claim
 * Status pill fell through to the green "Handed over" for every ranked member while all
 * 13 of them still had status = 'pending_fulfillment'. It asserted that PHP 5,000-10,000
 * cash plus a motorcycle and a laptop had been physically handed over when nothing had.
 */
const test = require('node:test');
const assert = require('node:assert');

const { applyPackageRankingGateToSnapshot } = require('../../services/ranking');

const DEFS = [
  { rank: 1, rank_code: 'supervisor_1', rank_name: 'Supervisor 1', points_required: 10000, left_rank_required: 0, right_rank_required: 0, sort_order: 10 },
  { rank: 2, rank_code: 'supervisor_2', rank_name: 'Supervisor 2', points_required: 20000, left_rank_required: 1, right_rank_required: 1, sort_order: 20 },
  { rank: 3, rank_code: 'supervisor_3', rank_name: 'Supervisor 3', points_required: 40000, left_rank_required: 2, right_rank_required: 2, sort_order: 30 },
];

const GOLD = 30;

// Shape mirrors what getAllRankings hands in for one row.
function listSnapshot(currentRank, storedPending) {
  return {
    currentRank,
    grossRankablePoints: 31220,
    consumedPoints: 30000,
    remainingRankablePoints: 1220,
    pendingAchievementCount: storedPending,
    leftQualifiedCount: 0,
    rightQualifiedCount: 0,
    achievements: [],
  };
}

const pending = (rank) => ({ rank, achievementStatus: 'pending_fulfillment' });
const fulfilled = (rank) => ({ rank, achievementStatus: 'fulfilled' });

test('LIST VIEW: stored pending count survives when no achievement rows are supplied', () => {
  // RonaldL01: current_rank 2, pending_achievement_count 2, both rows pending_fulfillment.
  const out = applyPackageRankingGateToSnapshot(listSnapshot(2, 2), GOLD, DEFS, []);
  assert.equal(out.pendingAchievementCount, 2,
    'stored pending count was clobbered to 0 - the board would read "Handed over"');
});

test('LIST VIEW: a single pending achievement survives (the other 12 ranked members)', () => {
  const out = applyPackageRankingGateToSnapshot(listSnapshot(1, 1), GOLD, DEFS, []);
  assert.equal(out.pendingAchievementCount, 1);
});

test('LIST VIEW: a genuinely settled member still reads 0', () => {
  const out = applyPackageRankingGateToSnapshot(listSnapshot(1, 0), GOLD, DEFS, []);
  assert.equal(out.pendingAchievementCount, 0);
});

test('LIST VIEW: an unranked member reads 0', () => {
  const out = applyPackageRankingGateToSnapshot(listSnapshot(0, 0), GOLD, DEFS, []);
  assert.equal(out.pendingAchievementCount, 0);
  assert.equal(out.currentRank, 0);
});

test('DETAIL VIEW: supplied achievement rows still drive the count (recompute wins)', () => {
  // Stored value is deliberately WRONG here; the real rows must win.
  const out = applyPackageRankingGateToSnapshot(
    listSnapshot(2, 99), GOLD, DEFS, [pending(1), pending(2)]
  );
  assert.equal(out.pendingAchievementCount, 2);
});

test('DETAIL VIEW: fulfilled rows are not counted as pending', () => {
  const out = applyPackageRankingGateToSnapshot(
    listSnapshot(2, 99), GOLD, DEFS, [fulfilled(1), pending(2)]
  );
  assert.equal(out.pendingAchievementCount, 1);
});

test('DETAIL VIEW: rows supplied but ALL filtered by the package gate must read 0, not the stored count', () => {
  // This is why the guard keys on `achievements`, not on `filteredAchievements`:
  // if the gate legitimately removes every row, 0 is the correct answer and the stored
  // count must NOT be restored.
  const out = applyPackageRankingGateToSnapshot(
    listSnapshot(2, 2), GOLD, DEFS, [pending(99)]  // rank 99 is beyond the published ladder
  );
  assert.equal(out.pendingAchievementCount, 0);
});

test('the current rank itself is never lost by the list view', () => {
  const out = applyPackageRankingGateToSnapshot(listSnapshot(2, 2), GOLD, DEFS, []);
  assert.equal(out.currentRank, 2);
  assert.equal(out.currentRankLabel, 'Supervisor 2');
});
