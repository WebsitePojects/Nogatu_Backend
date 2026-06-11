/**
 * Member Global Bonus Routes (DOC2 §4.3)
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const {
  getMemberGlobalBonus,
  getLatestPoolRecord,
} = require('../services/globalBonus');

/**
 * GET /api/global-bonus?year=YYYY
 * Returns member eligibility + annual distributed/projected share.
 * If no year is provided and the requested annual period has no pool yet,
 * falls back to the latest distributed period for better UX visibility.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const year = req.query.year;

    let details = await getMemberGlobalBonus(uid, year);
    let sourcePeriod = 'requested-period';

    if (!year && !details.pool) {
      const latestPool = await getLatestPoolRecord();
      if (latestPool) {
        details = await getMemberGlobalBonus(uid, latestPool.year);
        sourcePeriod = 'latest-distributed-period';
      }
    }

    res.json({
      ...details,
      sourcePeriod,
    });
  } catch (err) {
    console.error('[Global Bonus] Member fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/global-bonus/history
 * Returns all distribution records for the logged-in member across all years.
 */
router.get('/history', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    let rows = [];
    try {
      const [dbRows] = await pool.query(
        `SELECT period_year, period_month, period_scope, member_type,
                portions, share_amount, distributed_date, processid
         FROM globalbonus_membertab
         WHERE uid = ?
         ORDER BY period_year DESC, id DESC`,
        [uid]
      );
      rows = dbRows;
    } catch (_) { /* table may not exist yet */ }

    res.json({
      rows: rows.map((r) => ({
        periodYear: r.period_year,
        periodMonth: r.period_month,
        periodScope: r.period_scope,
        memberType: r.member_type,
        portions: Number(r.portions || 0),
        shareAmount: Number(r.share_amount || 0),
        distributedDate: r.distributed_date || null,
        processId: r.processid || null,
        status: r.distributed_date ? 'distributed' : 'pending',
      })),
    });
  } catch (err) {
    console.error('[Global Bonus] History fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
