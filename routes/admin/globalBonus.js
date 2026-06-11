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
  searchGlobalBonusMembers,
  addGlobalBonusMember,
  removeGlobalBonusMember,
  freezeGlobalBonusMember,
  unfreezeGlobalBonusMember,
} = require('../../services/globalBonus');

function parseClosedYearInput(rawYear) {
  if (rawYear == null || String(rawYear).trim() === '') {
    return undefined;
  }

  const yearText = String(rawYear).trim();
  if (!/^\d{4}$/.test(yearText)) {
    const error = new Error('Year must be a 4-digit closed year.');
    error.statusCode = 400;
    throw error;
  }

  const year = Number(yearText);
  const currentYear = new Date().getFullYear();
  if (year > currentYear - 1) {
    const error = new Error('Year must be a 4-digit closed year.');
    error.statusCode = 400;
    throw error;
  }

  return year;
}

/**
 * GET /api/admin/global-bonus?year=YYYY&page=1&perPage=30
 * Returns preview + distributed records for selected annual period.
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = parseClosedYearInput(req.query.year);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));

    const report = await getGlobalBonusReport(year, page, perPage);
    res.json(report);
  } catch (err) {
    console.error('[Admin Global Bonus] Report error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * GET /api/admin/global-bonus/preview?year=YYYY
 * Preview current computed pool/recipients without writing distribution rows.
 */
router.get('/preview', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = parseClosedYearInput(req.query.year);
    const preview = await calculateGlobalBonus(year);
    res.json(preview);
  } catch (err) {
    console.error('[Admin Global Bonus] Preview error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
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
 * GET /api/admin/global-bonus/search?year=YYYY&q=query
 * Search members for manual inclusion or state management.
 */
router.get('/search', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = parseClosedYearInput(req.query.year);
    const query = req.query.q;
    const members = await searchGlobalBonusMembers(query, year);
    res.json({ members });
  } catch (err) {
    console.error('[Admin Global Bonus] Search error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/members/add
 * Body: { year, uid? username?, portions?, memberType? }
 */
router.post('/members/add', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const processId = req.session.adminid || 'admin';
    const year = parseClosedYearInput(req.body?.year);
    const summary = await addGlobalBonusMember(year, req.body, processId);
    res.json({
      success: true,
      message: 'Global bonus member added successfully.',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Add member error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/members/:uid/remove
 */
router.post('/members/:uid/remove', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const processId = req.session.adminid || 'admin';
    const year = parseClosedYearInput(req.body?.year);
    const summary = await removeGlobalBonusMember(year, req.params.uid, processId);
    res.json({
      success: true,
      message: 'Global bonus member removed successfully.',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Remove member error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/members/:uid/freeze
 */
router.post('/members/:uid/freeze', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const processId = req.session.adminid || 'admin';
    const year = parseClosedYearInput(req.body?.year);
    const summary = await freezeGlobalBonusMember(year, req.params.uid, processId);
    res.json({
      success: true,
      message: 'Global bonus member frozen successfully.',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Freeze member error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/members/:uid/unfreeze
 */
router.post('/members/:uid/unfreeze', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const processId = req.session.adminid || 'admin';
    const year = parseClosedYearInput(req.body?.year);
    const summary = await unfreezeGlobalBonusMember(year, req.params.uid, processId);
    res.json({
      success: true,
      message: 'Global bonus member reactivated successfully.',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Unfreeze member error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/global-bonus/distribute
 * Body: { year?: YYYY }
 * Calculates and persists annual distribution rows.
 */
router.post('/distribute', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = parseClosedYearInput(req.body?.year);
    const processId = req.session.adminid || 'admin';

    const summary = await distributeGlobalBonus(year, processId);

    res.json({
      success: true,
      message: 'Annual global bonus distributed successfully',
      summary,
    });
  } catch (err) {
    console.error('[Admin Global Bonus] Distribute error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;
