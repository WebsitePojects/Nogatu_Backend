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
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 50;

    const [reports, counts] = await Promise.all([
      getPairingReport(uid),
      getPairingCounts(uid),
    ]);

    const total = reports.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const pageReports = reports.slice(start, start + perPage);

    res.json({ reports: pageReports, counts, page, totalPages, total });
  } catch (err) {
    console.error('[Pairing] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
