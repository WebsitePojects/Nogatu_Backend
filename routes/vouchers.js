/**
 * Voucher Routes (DOC2 §4.1)
 * Member voucher management — view and redeem vouchers
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { getVouchers, redeemVoucher } = require('../services/voucher');

/**
 * GET /api/vouchers
 * List member's vouchers
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const vouchers = await getVouchers(req.session.uid);
    res.json({ vouchers });
  } catch (err) {
    console.error('[Vouchers] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/vouchers/redeem
 * Redeem a voucher with cash top-up for product purchase
 * Body: { voucherId?, cashAmount, productKey?, productCode?, productName? }
 */
router.post('/redeem', memberAuth, async (req, res) => {
  try {
    const { voucherId, cashAmount, productKey, productCode, productName } = req.body;
    const parsedCashAmount = Number(cashAmount);

    if (!Number.isFinite(parsedCashAmount) || parsedCashAmount <= 0) {
      return res.status(400).json({ error: 'Cash amount must be greater than 0' });
    }

    let parsedVoucherId = null;
    if (voucherId !== undefined && voucherId !== null && voucherId !== '') {
      parsedVoucherId = Number(voucherId);
      if (!Number.isFinite(parsedVoucherId) || parsedVoucherId <= 0) {
        return res.status(400).json({ error: 'Voucher ID must be a positive number' });
      }
    }

    const safeProductName = typeof productName === 'string' ? productName.trim() : '';

    const result = await redeemVoucher(req.session.uid, parsedVoucherId, parsedCashAmount, {
      productKey,
      productCode,
      productName: safeProductName,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Vouchers] Redeem error:', err);
    res.status(400).json({ error: err.message || 'Redemption failed' });
  }
});

/**
 * GET /api/vouchers/transactions
 * List member's voucher transaction history
 */
router.get('/transactions', memberAuth, async (req, res) => {
  try {
    const { getVoucherTransactions } = require('../services/voucher');
    const transactions = await getVoucherTransactions(req.session.uid);
    res.json({ transactions });
  } catch (err) {
    console.error('[Vouchers] Transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
