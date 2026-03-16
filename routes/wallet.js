/**
 * E-Wallet / Income Routes
 * 1:1 port of PHP ewallet.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { getDREF } = require('../services/income/directReferral');
const { getPairing } = require('../services/income/pairing');
const { getLeadershipBonus } = require('../services/income/leadership');
const { getUnilevel, checkLastMaintenance, checkUnilevelTransDate } = require('../services/income/unilevel');
const { getLPC } = require('../services/income/lpc');
const { insertIncome, insertEncashment } = require('../services/income/insertIncome');

/**
 * GET /api/wallet
 * Get wallet overview with all income calculations
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const currentaccttype = req.session.currentaccttype;

    // Get current totals
    const [totals] = await pool.query(
      'SELECT * FROM payouttotaltab WHERE uid = ?',
      [uid]
    );
    const currentTotals = totals[0] || {};
    const beginningBalance = Number(currentTotals.ttlcashbalance || 0);

    // Calculate each income type
    const drefResult = await getDREF(uid);
    const pairingAmount = await getPairing(uid, currentaccttype);
    const leadershipAmount = await getLeadershipBonus(uid);

    // Unilevel only if maintenance met and not yet calculated
    const hasMaintenance = await checkLastMaintenance(uid);
    const alreadyCalcUnilevel = await checkUnilevelTransDate(uid);
    let unilevelAmount = 0;
    if (hasMaintenance && !alreadyCalcUnilevel) {
      unilevelAmount = await getUnilevel(uid);
    }

    const lpcAmount = await getLPC(uid);

    // Calculate new amounts (subtract already claimed)
    const newDref = Math.max(0, drefResult.directreferral - Number(currentTotals.ttlincome1 || 0));
    const newPairing = Math.max(0, pairingAmount - Number(currentTotals.ttlincome2 || 0));
    const newLeadership = Math.max(0, leadershipAmount - Number(currentTotals.ttlincome3 || 0));
    const newHifive = Math.max(0, drefResult.hifive - Number(currentTotals.ttlincome5 || 0));

    const totalNewIncome = newDref + newPairing + newLeadership + unilevelAmount + newHifive + lpcAmount;
    const endingBalance = beginningBalance + totalNewIncome;

    // Insert income if > 0
    if (totalNewIncome >= 1) {
      await insertIncome(uid, {
        dref: newDref,
        paircash: newPairing,
        leadership: newLeadership,
        unilevel: unilevelAmount,
        hifive: newHifive,
        lpc: lpcAmount,
        beginningbalance: beginningBalance,
        endingbalance: endingBalance,
      });
    }

    // Re-fetch updated totals
    const [updatedTotals] = await pool.query(
      'SELECT * FROM payouttotaltab WHERE uid = ?',
      [uid]
    );
    const updated = updatedTotals[0] || {};

    res.json({
      directReferral: Number(updated.ttlincome1 || 0),
      pairing: Number(updated.ttlincome2 || 0),
      leadership: Number(updated.ttlincome3 || 0),
      unilevel: Number(updated.ttlincome4 || 0),
      hifive: Number(updated.ttlincome5 || 0),
      lpc: Number(updated.ttlincome6 || 0),
      cashBalance: Number(updated.ttlcashbalance || 0),
      totalIncome: Number(updated.ttlincome1 || 0) + Number(updated.ttlincome2 || 0) +
                   Number(updated.ttlincome4 || 0) + Number(updated.ttlincome5 || 0) +
                   Number(updated.ttlincome6 || 0),
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
    const { amount } = req.body;

    if (!amount || amount < 500) {
      return res.status(400).json({ error: 'Minimum encashment is 500' });
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
