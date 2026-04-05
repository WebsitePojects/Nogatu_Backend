/**
 * Member Global Bonus Routes (DOC2 §4.3)
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const {
  getMemberGlobalBonus,
  getLatestPoolRecord,
} = require('../services/globalBonus');

/**
 * GET /api/global-bonus?month=MM&year=YYYY
 * Returns member eligibility + monthly distributed/projected share.
 * If no month/year is provided and current period has no pool yet,
 * falls back to the latest distributed period for better UX visibility.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const month = req.query.month;
    const year = req.query.year;

    let details = await getMemberGlobalBonus(uid, month, year);
    let sourcePeriod = 'requested-period';

    if (!month && !year && !details.pool) {
      const latestPool = await getLatestPoolRecord();
      if (latestPool) {
        details = await getMemberGlobalBonus(uid, latestPool.month, latestPool.year);
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

module.exports = router;
