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

module.exports = router;
