/**
 * Global Leaderboard Routes
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const {
  getRankProgress,
  RANK_REQUIREMENTS,
  PACKAGE_LABELS,
} = require('../services/ranking');

/**
 * GET /api/leaderboard?page=1&perPage=25
 * Global binary points leaderboard + current user progress.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 25));
    const offset = (page - 1) * perPage;

    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM usertab WHERE codeid = 1 AND uid = mainid'
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT u.uid, u.currentaccttype,
              m.username, m.firstname, m.lastname,
              COALESCE((
                SELECT p.totalbpay
                FROM pairingstab p
                WHERE p.uid = u.uid
                ORDER BY p.transdate DESC, p.id DESC
                LIMIT 1
              ), 0) AS binaryPoints
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.codeid = 1 AND u.uid = u.mainid
       ORDER BY binaryPoints DESC, u.uid ASC
       LIMIT ?, ?`,
      [offset, perPage]
    );

    const [userPointRows] = await pool.query(
      `SELECT COALESCE((
          SELECT p.totalbpay
          FROM pairingstab p
          WHERE p.uid = u.uid
          ORDER BY p.transdate DESC, p.id DESC
          LIMIT 1
       ), 0) AS binaryPoints
       FROM usertab u
       WHERE u.uid = ? AND u.codeid = 1 AND u.uid = u.mainid
       LIMIT 1`,
      [uid]
    );

    const userPoints = Number(userPointRows[0]?.binaryPoints || 0);
    let userRank = null;
    if (userPointRows.length > 0) {
      const [rankRows] = await pool.query(
        `SELECT COUNT(*) AS rankPosition
         FROM usertab u
         WHERE u.codeid = 1
           AND u.uid = u.mainid
           AND (
             COALESCE((
               SELECT p.totalbpay
               FROM pairingstab p
               WHERE p.uid = u.uid
               ORDER BY p.transdate DESC, p.id DESC
               LIMIT 1
             ), 0) > ?
             OR (
               COALESCE((
                 SELECT p.totalbpay
                 FROM pairingstab p
                 WHERE p.uid = u.uid
                 ORDER BY p.transdate DESC, p.id DESC
                 LIMIT 1
               ), 0) = ?
               AND u.uid <= ?
             )
           )`,
        [userPoints, userPoints, uid]
      );

      userRank = Number(rankRows[0]?.rankPosition || null);
    }

    const userProgress = await getRankProgress(uid);
    const currentRank = Number(userProgress.currentRank || 0);
    const nextRank = currentRank < 3 ? currentRank + 1 : null;
    const nextRankPoints = nextRank ? Number(RANK_REQUIREMENTS[nextRank].minPoints || 0) : null;

    const leaderboard = rows.map((r, idx) => {
      const position = offset + idx + 1;
      return {
        rank: position,
        uid: Number(r.uid),
        username: r.username,
        fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim(),
        packageType: Number(r.currentaccttype || 0),
        package: PACKAGE_LABELS[Number(r.currentaccttype || 0)] || 'Unknown',
        binaryPoints: Number(r.binaryPoints || 0),
        supervisorRank: 0,
        supervisorRankLabel: 'Unranked',
        isCurrentUser: Number(r.uid) === uid,
      };
    });

    const rankMap = new Map();
    if (leaderboard.length > 0) {
      const ids = leaderboard.map((r) => r.uid);
      const placeholders = ids.map(() => '?').join(',');
      const [rankRows] = await pool.query(
        `SELECT uid, current_rank, rank_level
         FROM rankingstab
         WHERE uid IN (${placeholders})`,
        ids
      );

      for (const row of rankRows) {
        const rank = Math.max(Number(row.current_rank || 0), Number(row.rank_level || 0));
        rankMap.set(Number(row.uid), rank);
      }
    }

    for (const row of leaderboard) {
      const rank = Number(rankMap.get(row.uid) || 0);
      row.supervisorRank = rank;
      row.supervisorRankLabel = rank > 0 ? `Supervisor ${rank}` : 'Unranked';
    }

    res.json({
      leaderboard,
      userRank,
      userPoints,
      userSupervisorRank: Number(userProgress.currentRank || 0),
      nextRankPoints,
      supervisorProgress: {
        s1: userProgress.ranks?.find((r) => Number(r.rank) === 1) || null,
        s2: userProgress.ranks?.find((r) => Number(r.rank) === 2) || null,
        s3: userProgress.ranks?.find((r) => Number(r.rank) === 3) || null,
      },
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    });
  } catch (err) {
    console.error('[Leaderboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
