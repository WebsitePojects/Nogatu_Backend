/**
 * E-Wallet / Income Routes
 * 1:1 port of PHP ewallet.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');
const { insertEncashment } = require('../services/income/insertIncome');
const { pool } = require('../config/database');

/**
 * GET /api/wallet
 * Calculate and return all income totals for the logged-in member.
 * Uses the shared calculateAndStoreIncome service — same as dashboard,
 * so values are consistent and never incremented by repeated page loads.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const currentaccttype = req.session.currentaccttype;

    const updated = await calculateAndStoreIncome(uid, currentaccttype);

    res.json({
      directReferral: Number(updated.ttlincome1 || 0),
      pairing:        Number(updated.ttlincome2 || 0),
      leadership:     Number(updated.ttlincome3 || 0),
      unilevel:       Number(updated.ttlincome4 || 0),
      hifive:         Number(updated.ttlincome5 || 0),
      lpc:            Number(updated.ttlincome6 || 0),
      cashBalance:    Number(updated.ttlcashbalance || 0),
      totalIncome:    Number(updated.ttlincome1 || 0) + Number(updated.ttlincome2 || 0) +
                      Number(updated.ttlincome3 || 0) + Number(updated.ttlincome4 || 0) +
                      Number(updated.ttlincome5 || 0) + Number(updated.ttlincome6 || 0),
    });
  } catch (err) {
    console.error('[Wallet] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/wallet/encash
 * Process encashment (minimum 500)
 */
router.post('/encash', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const amount = Number(req.body.amount);

    if (!amount || isNaN(amount) || amount < 500) {
      return res.status(400).json({ error: 'Minimum encashment is ₱500' });
    }

    // Get user info for CD deduction check
    const [userRows] = await pool.query(
      'SELECT codeid, cdstatus, cdamount, cdtotal FROM usertab WHERE uid = ?',
      [uid]
    );

    const userInfo = userRows[0] || {};
    const result = await insertEncashment(uid, amount, userInfo);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Wallet] Encashment error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;
