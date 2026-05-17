/**
 * Pairing Reports Routes
 * 1:1 port of PHP pairing-reports.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const { getPairingCounts } = require('../services/network');
const { backfillHistoricalBinaryPointEvents, getPairingTrace } = require('../services/income/pairingTracker');
const { getPackagePolicy } = require('../services/packagePolicy');
const { getEffectiveAccountState, countsForPairingSource } = require('../services/accountState');

router.get('/sources', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
    await backfillHistoricalBinaryPointEvents(uid).catch((error) => {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    });

    try {
      const [rows] = await pool.query(
        `SELECT bpe.event_uid, bpe.source_member_uid, bpe.parent_uid, c.leg AS owner_leg,
                bpe.event_type, bpe.package_type, bpe.point_value,
                bpe.reference_key, bpe.event_ts,
                m.username, m.firstname, m.lastname
         FROM binary_tree_closuretab c
         INNER JOIN binary_point_eventstab bpe ON bpe.source_member_uid = c.descendant_uid
         LEFT JOIN memberstab m ON m.uid = bpe.source_member_uid
         WHERE c.ancestor_uid = ? AND c.depth > 0 AND c.leg IN ('left', 'right') AND bpe.deleted_at IS NULL
         ORDER BY bpe.event_ts DESC, bpe.id DESC
         LIMIT ?`,
        [uid, limit]
      );

      return res.json({
        source: 'binary_point_eventstab',
        formula: 'Each row is a binary point event triggered by a downline account or qualifying upgrade, grouped by your left or right leg.',
        rows: rows.map((row) => ({
          ...row,
          leg: row.owner_leg,
          point_value: Number(row.point_value || 0),
          full_name: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
        })),
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
    const uid = Number(req.session.uid);
    const accttype = Number(req.session.currentaccttype || req.session.accttype || 0);
    const packagePolicy = getPackagePolicy(accttype);
    const effectiveAccount = await getEffectiveAccountState(uid);
    const canEarnPairing = countsForPairingSource(effectiveAccount);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(10, Number(req.query.perPage) || 50));
    const offset = (page - 1) * perPage;

    const [totalRows, reports, counts, trace, walletRows] = await Promise.all([
      canEarnPairing
        ? pool.query('SELECT COUNT(*) AS total FROM pairingstab WHERE uid = ? AND totalpoints >= 1', [uid]).then(([rows]) => rows)
        : Promise.resolve([{ total: 0 }]),
      canEarnPairing
        ? pool.query(
          `SELECT *
           FROM pairingstab
           WHERE uid = ?
             AND totalpoints >= 1
           ORDER BY id DESC
           LIMIT ? OFFSET ?`,
          [uid, perPage, offset]
        ).then(([rows]) => rows)
        : Promise.resolve([]),
      getPairingCounts(uid),
      canEarnPairing
        ? getPairingTrace(uid, accttype, { limit: 50 }).catch((error) => {
          if (error.code === 'ER_NO_SUCH_TABLE') {
            return {
              rows: [],
              summary: {
                totalEvents: 0,
                totalPairPoints: 0,
                totalGrossIncome: 0,
                totalCreditedIncome: 0,
                cappedEvents: 0,
                uncappedEvents: 0,
              },
              weeklyCap: 0,
              packageName: null,
              sourceBackfill: { inserted: 0, skipped: 0 },
            };
          }
          throw error;
        })
        : Promise.resolve({
          rows: [],
          summary: {
            totalEvents: 0,
            totalPairPoints: 0,
            totalGrossIncome: 0,
            totalCreditedIncome: 0,
            cappedEvents: 0,
            uncappedEvents: 0,
          },
          weeklyCap: Number(packagePolicy.pairingWeeklyCap || 0),
          packageName: packagePolicy.packageLabel || null,
          sourceBackfill: { inserted: 0, skipped: 0 },
        }),
      pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]).then(([rows]) => rows),
    ]);

    const total = Number(totalRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const walletPairingTotal = Number(walletRows[0]?.ttlincome2 || 0);

    res.json({
      reports,
      counts,
      page,
      perPage,
      totalPages,
      total,
      trace,
      packagePolicy,
      walletPairingTotal,
      eligibility: {
        canEarnPairing,
        reason: canEarnPairing
          ? null
          : 'This account cannot receive sales matched bonus while it is FS or an unpaid CD account.',
      },
    });
  } catch (err) {
    console.error('[Pairing] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
