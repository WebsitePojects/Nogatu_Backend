/**
 * Direct Referrals Routes
 * 1:1 port of PHP mydirectreferrals.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { getDirectReferrals } = require('../services/network');

/**
 * GET /api/referrals
 * Get all direct referrals for logged-in member
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const referrals = await getDirectReferrals(uid);
    res.json({ referrals });
  } catch (err) {
    console.error('[Referrals] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
