/**
 * Pairing Reports Routes
 * 1:1 port of PHP pairing-reports.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const { getPairingCounts } = require('../services/network');

router.get('/sources', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));

    try {
      const [rows] = await pool.query(
        `SELECT bpe.event_uid, bpe.source_member_uid, bpe.parent_uid, bpe.leg,
                bpe.event_type, bpe.package_type, bpe.point_value,
                bpe.reference_key, bpe.event_ts,
                m.username, m.firstname, m.lastname
         FROM binary_tree_closuretab c
         INNER JOIN binary_point_eventstab bpe ON bpe.source_member_uid = c.descendant_uid
         LEFT JOIN memberstab m ON m.uid = bpe.source_member_uid
         WHERE c.ancestor_uid = ? AND c.depth > 0 AND bpe.deleted_at IS NULL
         ORDER BY bpe.event_ts DESC, bpe.id DESC
         LIMIT ?`,
        [uid, limit]
      );

      return res.json({
        source: 'binary_point_eventstab',
        formula: 'Each row is a binary point event triggered by a downline account or product activity.',
        rows: rows.map((row) => ({ ...row, point_value: Number(row.point_value || 0) })),
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }

    const [rows] = await pool.query(
      `SELECT id, totalleft, totalright, totalpointsleft, totalpointsright,
              \`left\` AS left_balance, \`right\` AS right_balance, transdate
       FROM pairingstab
       WHERE uid = ?
       ORDER BY id DESC
       LIMIT ?`,
      [uid, limit]
    );
    res.json({
      source: 'pairingstab_fallback',
      formula: 'Ledger tables are not migrated yet; showing latest pairing snapshots.',
      rows,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Pairing] Sources error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pairing
 * Get pairing report data
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(10, Number(req.query.perPage) || 50));
    const offset = (page - 1) * perPage;

    const [totalRows, reports, counts] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM pairingstab WHERE uid = ?', [uid]).then(([rows]) => rows),
      pool.query(
        `SELECT *
         FROM pairingstab
         WHERE uid = ?
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [uid, perPage, offset]
      ).then(([rows]) => rows),
      getPairingCounts(uid),
    ]);

    const total = Number(totalRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    res.json({ reports, counts, page, perPage, totalPages, total });
  } catch (err) {
    console.error('[Pairing] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
