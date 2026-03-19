/**
 * Ranking Routes (DOC2 §4.2)
 * Member ranking progress
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { getRankProgress } = require('../services/ranking');

/**
 * GET /api/ranking
 * Get member's rank progress
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const progress = await getRankProgress(req.session.uid);
    res.json(progress);
  } catch (err) {
    console.error('[Ranking] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
