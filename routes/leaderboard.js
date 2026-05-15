/**
 * Global Leaderboard Routes
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const {
  getAllRankings,
  getRankProgress,
} = require('../services/ranking');

/**
 * GET /api/leaderboard?page=1&perPage=25
 * Global repurchase points leaderboard + current user progress.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 25));
    const [leaderboardResult, userProgress] = await Promise.all([
      getAllRankings(page, perPage),
      getRankProgress(uid),
    ]);
    const rankDefinitions = userProgress.rankDefinitions || [];

    const userRankRank = Number(userProgress.currentRank || 0);
    const userRemaining = Number(userProgress.remainingRankablePoints || 0);
    const userGross = Number(userProgress.grossRankablePoints || 0);
    const userAwardedAt = String(userProgress.qualifiedDate || '9999-12-31 23:59:59');

    const [rankRows] = await pool.query(
      `SELECT COUNT(*) AS rankPosition
       FROM rankingstab r
       INNER JOIN usertab u ON u.uid = r.uid
       WHERE u.codeid = 1
         AND u.uid = u.mainid
         AND (
           GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) > ?
           OR (
             GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) = ?
             AND COALESCE(r.remaining_rankable_points, 0) > ?
           )
           OR (
             GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) = ?
             AND COALESCE(r.remaining_rankable_points, 0) = ?
             AND COALESCE(r.basis_points, 0) > ?
           )
           OR (
             GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) = ?
             AND COALESCE(r.remaining_rankable_points, 0) = ?
             AND COALESCE(r.basis_points, 0) = ?
             AND COALESCE(r.race_last_awarded_at, r.rank_date, r.qualified_date, '9999-12-31 23:59:59') < ?
           )
           OR (
             GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) = ?
             AND COALESCE(r.remaining_rankable_points, 0) = ?
             AND COALESCE(r.basis_points, 0) = ?
             AND COALESCE(r.race_last_awarded_at, r.rank_date, r.qualified_date, '9999-12-31 23:59:59') = ?
             AND r.uid <= ?
           )
         )`,
      [
        userRankRank,
        userRankRank, userRemaining,
        userRankRank, userRemaining, userGross,
        userRankRank, userRemaining, userGross, userAwardedAt,
        userRankRank, userRemaining, userGross, userAwardedAt, uid,
      ]
    );

    const leaderboard = (leaderboardResult.rankings || []).map((row) => ({
      rank: Number(row.position || 0),
      uid: Number(row.uid),
      username: row.username,
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
      packageType: Number(row.packageType || 0),
      package: row.packageLabel || 'Unknown',
      currentRank: Number(row.currentRank || 0),
      currentRankLabel: row.currentRankLabel || 'Unranked',
      rankLabel: row.currentRankLabel || 'Unranked',
      rankColor: row.rankColor || '#6B7280',
      grossRankablePoints: Number(row.grossRankablePoints || 0),
      remainingRankablePoints: Number(row.remainingRankablePoints || 0),
      repurchasePoints: Number(row.repurchasePoints || row.grossRankablePoints || 0),
      consumedPoints: Number(row.consumedPoints || 0),
      awardedAt: row.qualifiedDate || null,
      pendingAchievementCount: Number(row.pendingAchievementCount || 0),
      isCurrentUser: Number(row.uid) === uid,
    }));

    res.json({
      leaderboard,
      rankDefinitions,
      userRank: Number(rankRows[0]?.rankPosition || null),
      userPoints: userGross,
      userRepurchasePoints: userGross,
      userGrossRankablePoints: userGross,
      userRemainingRankablePoints: userRemaining,
      userConsumedPoints: Number(userProgress.consumedPoints || 0),
      pointsBasis: 'Repurchase points',
      rankingScope: 'Self + full downline',
      payoutReleaseMode: 'Manual admin release',
      userCurrentRank: Number(userProgress.currentRank || 0),
      userCurrentRankLabel: userProgress.currentRankLabel || 'Unranked',
      nextRankPoints: Number(userProgress.nextRankMinPoints || 0),
      nextRankRequirement: userProgress.nextRankRequirement || null,
      raceProgress: userProgress,
      pagination: {
        page: leaderboardResult.page,
        perPage: leaderboardResult.perPage,
        total: leaderboardResult.total,
        totalPages: leaderboardResult.totalPages,
      },
    });
  } catch (err) {
    console.error('[Leaderboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
