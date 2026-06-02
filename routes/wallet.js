/**
 * E-Wallet / Income Routes
 * 1:1 port of PHP ewallet.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');
const { insertEncashment, getEncashmentPreview } = require('../services/income/insertIncome');
const { getMemberGlobalBonus } = require('../services/globalBonus');

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
    const globalBonus = await getMemberGlobalBonus(uid).catch(() => ({
      eligible: false,
      visibilityState: 'locked',
      interactive: false,
      fullVisibility: false,
      lockedReason: 'Global bonus status is unavailable right now.',
      labels: [],
      portions: 0,
    }));

    res.json({
      directReferral: Number(updated.ttlincome1 || 0),
      pairing:        Number(updated.ttlincome2 || 0),
      leadership:     Number(updated.ttlincome3 || 0),
      unilevel:       Number(updated.ttlincome4 || 0),
      hifive:         Number(updated.ttlincome5 || 0),
      rankingBonus:   Number(updated.ttlincome6 || 0),
      legacyIncome6:  Number(updated.ttlincome6 || 0),
      cashBalance:    Number(updated.ttlcashbalance || 0),
      globalBonusStatus: {
        eligible: Boolean(globalBonus.eligible),
        visibilityState: globalBonus.visibilityState || (globalBonus.eligible ? 'unlocked' : 'locked'),
        interactive: Boolean(globalBonus.interactive),
        fullVisibility: Boolean(globalBonus.fullVisibility),
        lockedReason: globalBonus.lockedReason || null,
        labels: Array.isArray(globalBonus.labels) ? globalBonus.labels : [],
        portions: Number(globalBonus.portions || 0),
      },
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
 * POST /api/wallet/preview-encash
 * Validate payout readiness and show all deductions before submit.
 */
router.post('/preview-encash', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount greater than zero' });
    }

    const preview = await getEncashmentPreview(uid, amount);
    if (!preview.payout.ok) {
      return res.status(422).json({
        error: preview.payout.message,
        code: preview.payout.code,
        preview,
      });
    }

    if (!preview.sufficientBalance) {
      return res.status(422).json({
        error: 'Insufficient cash balance for this encashment amount.',
        code: 'INSUFFICIENT_BALANCE',
        preview,
      });
    }

    res.json({ success: true, preview });
  } catch (err) {
    console.error('[Wallet] Encashment preview error:', err);
    if (err.message === 'Invalid encashment amount') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/wallet/encash
 * Process encashment
 */
router.post('/encash', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount greater than zero' });
    }

    const result = await insertEncashment(uid, amount, null, {
      req,
      requestId: req.requestId || req.headers['x-request-id'],
    });

    res.json({
      success: true,
      pid: result.pid,
      cdDeduction: Number(result.cdDeduction || 0),
      maintenanceFee: Number(result.maintenanceFee || 0),
      netReceivable: Number(result.netReceivable || 0),
      newBalance: Number(result.newBalance || 0),
      paymentOption: result.paymentOption || null,
      paymentDetails: result.paymentDetails || null,
      payoutDate: result.payoutDate || null,
      ...result,
    });
  } catch (err) {
    console.error('[Wallet] Encashment error:', err);
    if (err.message === 'Invalid encashment amount') {
      return res.status(400).json({ error: err.message });
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
