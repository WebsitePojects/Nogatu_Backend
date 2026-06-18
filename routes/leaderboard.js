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

    const userRemaining = Number(userProgress.remainingRankablePoints || 0);
    const userGross = Number(userProgress.grossRankablePoints || 0);
    const userAwardedAt = String(userProgress.qualifiedDate || '9999-12-31 23:59:59');

    const [rankRows] = await pool.query(
      `SELECT COUNT(*) AS rankPosition
       FROM rankingstab r
       INNER JOIN usertab u ON u.uid = r.uid
       WHERE u.uid = u.mainid
        AND (
           COALESCE(r.remaining_rankable_points, 0) > ?
           OR (
             COALESCE(r.remaining_rankable_points, 0) = ?
             AND COALESCE(r.race_last_awarded_at, r.rank_date, r.qualified_date, '9999-12-31 23:59:59') < ?
           )
           OR (
             COALESCE(r.remaining_rankable_points, 0) = ?
             AND COALESCE(r.race_last_awarded_at, r.rank_date, r.qualified_date, '9999-12-31 23:59:59') = ?
             AND r.uid < ?
           )
         )`,
      [
        userRemaining,
        userRemaining, userAwardedAt,
        userRemaining, userAwardedAt, uid,
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

    const aheadCount = Number(rankRows[0]?.rankPosition || 0);
    const userLeaderboardPosition = leaderboardResult.total > 0 ? aheadCount + 1 : 0;

    res.json({
      leaderboard,
      rankDefinitions,
      userRank: userLeaderboardPosition,
      userLeaderboardPosition,
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

/**
 * GET /api/leaderboard/movements?page=1&perPage=50
 * Transparent point-movement ledger for the logged-in member: every ADDITION
 * (a repurchase anywhere in their sponsor subtree) and every DEDUCTION (points
 * consumed when a member in their subtree achieved a rank). Makes upline point
 * deductions visible/auditable so consumption can never silently drain a pool.
 */
router.get('/movements', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(10, Number(req.query.perPage) || 50));
    const offset = (page - 1) * perPage;

    let totalsRow = {};
    try {
      const [tr] = await pool.query(
        'SELECT gross_points, consumed_points, remaining_points FROM member_rank_pointstab WHERE member_uid = ? LIMIT 1',
        [uid]
      );
      totalsRow = tr[0] || {};
    } catch { /* shadow table not migrated yet */ }

    const subtreeCte = `
      WITH RECURSIVE tree AS (
        SELECT uid FROM usertab WHERE uid = ?
        UNION ALL SELECT c.uid FROM usertab c JOIN tree t ON c.drefid = t.uid AND c.uid <> t.uid
      )`;
    const movementUnion = `
      SELECT r.transdate AS ts, 'add' AS direction, r.incentivepoints1 AS points,
             COALESCE(rm.username, CONCAT('uid ', r.uid)) AS actor, 'Repurchase' AS reason
        FROM repurchasetab r
        JOIN tree t ON t.uid = r.uid
        LEFT JOIN memberstab rm ON rm.uid = r.uid
       WHERE IFNULL(r.incentivepoints1,0) > 0
      UNION ALL
      SELECT gc.consumed_at AS ts, 'deduct' AS direction, gc.points_consumed AS points,
             COALESCE(cm.username, CONCAT('uid ', gc.consuming_member_uid)) AS actor,
             CONCAT('Consumed by rank: ', COALESCE(d.rank_name, 'rank achievement')) AS reason
        FROM rank_global_consumptiontab gc
        JOIN tree t ON t.uid = gc.source_member_uid
        LEFT JOIN memberstab cm ON cm.uid = gc.consuming_member_uid
        LEFT JOIN rank_achievementstab a ON a.achievement_uid = gc.consuming_rank_uid
        LEFT JOIN rank_definitionstab d ON d.definition_uid = a.rank_definition_uid
       WHERE IFNULL(gc.points_consumed,0) > 0`;

    const [countRows] = await pool.query(
      `${subtreeCte} SELECT COUNT(*) AS total FROM (${movementUnion}) mv`, [uid]
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `${subtreeCte}
       SELECT DATE_FORMAT(mv.ts,'%Y-%m-%d %H:%i') AS at, mv.direction, mv.points, mv.actor, mv.reason
       FROM (${movementUnion}) mv
       ORDER BY mv.ts DESC
       LIMIT ?, ?`,
      [uid, offset, perPage]
    );

    res.json({
      totals: {
        gross: Number(totalsRow.gross_points || 0),
        consumed: Number(totalsRow.consumed_points || 0),
        remaining: Number(totalsRow.remaining_points || 0),
      },
      movements: rows.map((r) => ({
        at: r.at,
        direction: r.direction,
        points: Number(r.points || 0),
        actor: r.actor,
        reason: r.reason,
      })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error('[Leaderboard] movements error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/leaderboard/bloodline?page&perPage
 * The member's repurchase-point contributors: every DOWNLINE member (self excluded)
 * whose repurchases roll up into this member's ranking points, grouped by member with
 * gross / consumed / net points + a grand tally. Proves the leaderboard figure comes
 * from real, eligible bloodline — and is exportable.
 */
router.get('/bloodline', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(10, Number(req.query.perPage) || 50));
    const offset = (page - 1) * perPage;

    const subCte = `
      WITH RECURSIVE sub AS (
        SELECT uid, 0 AS d FROM usertab WHERE uid = ?
        UNION ALL
        SELECT u.uid, sub.d + 1 FROM usertab u JOIN sub ON u.drefid = sub.uid AND u.uid <> sub.uid WHERE sub.d < 30
      ),
      gc AS (SELECT repurchase_id, SUM(points_consumed) AS c FROM rank_global_consumptiontab GROUP BY repurchase_id)`;

    const [totalRows] = await pool.query(
      `${subCte}
       SELECT COUNT(DISTINCT r.uid) AS contributors,
              COALESCE(SUM(r.incentivepoints1),0) AS gross,
              COALESCE(SUM(GREATEST(0, r.incentivepoints1 - COALESCE(gc.c,0))),0) AS net
       FROM repurchasetab r
       JOIN sub ON sub.uid = r.uid AND sub.d > 0
       LEFT JOIN gc ON gc.repurchase_id = r.id
       WHERE r.incentivepoints1 > 0`,
      [uid]
    );
    const t = totalRows[0] || { contributors: 0, gross: 0, net: 0 };

    const [countRows] = await pool.query(
      `${subCte}
       SELECT COUNT(*) AS total FROM (
         SELECT r.uid FROM repurchasetab r JOIN sub ON sub.uid = r.uid AND sub.d > 0
         WHERE r.incentivepoints1 > 0 GROUP BY r.uid
       ) x`,
      [uid]
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `${subCte}
       SELECT r.uid AS sourceUid, m.username, m.firstname, m.lastname,
              MIN(sub.d) AS level, COUNT(*) AS events,
              COALESCE(SUM(r.incentivepoints1),0) AS gross,
              COALESCE(SUM(GREATEST(0, r.incentivepoints1 - COALESCE(gc.c,0))),0) AS net
       FROM repurchasetab r
       JOIN sub ON sub.uid = r.uid AND sub.d > 0
       JOIN memberstab m ON m.uid = r.uid
       LEFT JOIN gc ON gc.repurchase_id = r.id
       WHERE r.incentivepoints1 > 0
       GROUP BY r.uid, m.username, m.firstname, m.lastname
       ORDER BY gross DESC, sourceUid ASC
       LIMIT ?, ?`,
      [uid, offset, perPage]
    );

    res.json({
      totals: {
        contributors: Number(t.contributors || 0),
        gross: Number(t.gross || 0),
        net: Number(t.net || 0),
        consumed: Math.max(0, Number(t.gross || 0) - Number(t.net || 0)),
      },
      contributors: rows.map((r) => ({
        uid: Number(r.sourceUid),
        username: r.username,
        fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim() || r.username,
        level: Number(r.level),
        events: Number(r.events),
        gross: Number(r.gross),
        net: Number(r.net),
        consumed: Math.max(0, Number(r.gross) - Number(r.net)),
      })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error('[Leaderboard] bloodline error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
