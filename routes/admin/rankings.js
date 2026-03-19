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
    const result = await getAllRankings(page);
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
    const success = await processIncentive(uid);
    if (success) {
      res.json({ success: true, message: 'Incentive marked as claimed' });
    } else {
      res.status(400).json({ error: 'No pending incentive found' });
    }
  } catch (err) {
    console.error('[Admin Rankings] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
