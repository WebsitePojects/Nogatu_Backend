/**
 * Pairing Reports Routes
 * 1:1 port of PHP pairing-reports.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { getPairingReport } = require('../services/income/pairing');
const { getPairingCounts } = require('../services/network');

/**
 * GET /api/pairing
 * Get pairing report data
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;

    const [reports, counts] = await Promise.all([
      getPairingReport(uid),
      getPairingCounts(uid),
    ]);

    res.json({ reports, counts });
  } catch (err) {
    console.error('[Pairing] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
