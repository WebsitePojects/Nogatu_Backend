/**
 * Admin Global Bonus Routes (DOC2 §4.3)
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  calculateGlobalBonus,
  distributeGlobalBonus,
  getGlobalBonusReport,
  getLatestPoolRecord,
} = require('../../services/globalBonus');

/**
 * GET /api/admin/global-bonus?month=MM&year=YYYY&page=1&perPage=30
 * Returns preview + distributed records for selected period.
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const month = req.query.month;
    const year = req.query.year;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));

    const report = await getGlobalBonusReport(month, year, page, perPage);
    res.json(report);
  } catch (err) {
    console.error('[Admin Global Bonus] Report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/global-bonus/preview?month=MM&year=YYYY
 * Preview current computed pool/recipients without writing distribution rows.
 */
router.get('/preview', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const month = req.query.month;
    const year = req.query.year;
    const preview = await calculateGlobalBonus(month, year);
    res.json(preview);
  } catch (err) {
    console.error('[Admin Global Bonus] Preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/global-bonus/latest
 * Returns latest distributed pool metadata for quick navigation.
 */
router.get('/latest', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const latest = await getLatestPoolRecord();
    res.json({ latest: latest || null });
  } catch (err) {
    console.error('[Admin Global Bonus] Latest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/distribute
 * Body: { month?: MM, year?: YYYY }
 * Calculates and persists monthly distribution rows.
 */
router.post('/distribute', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const month = req.body?.month;
    const year = req.body?.year;
    const processId = req.session.adminid || 'admin';

    const summary = await distributeGlobalBonus(month, year, processId);

    res.json({
      success: true,
      message: 'Global bonus distributed successfully',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Distribute error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;
