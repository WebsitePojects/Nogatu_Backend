/**
 * Admin Rankings Routes (DOC2 §4.2)
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAllRankings, processIncentive } = require('../../services/ranking');

/**
 * GET /api/admin/rankings?page=1
 * View all ranked members
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));
    const result = await getAllRankings(page, perPage);
    res.json(result);
  } catch (err) {
    console.error('[Admin Rankings] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/rankings/:uid/process
 * Mark incentive as claimed
 */
router.put('/:uid/process', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const result = await processIncentive(uid, {
      req,
      adminUid: req.session.adminid,
    });
    if (result.success) {
      res.json({
        success: true,
        message: 'Next pending ranking bonus claim released',
        ...result,
      });
    } else {
      res.status(400).json({ error: result.error || 'No pending incentive found' });
    }
  } catch (err) {
    console.error('[Admin Rankings] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
