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
 * Body: { voucherId, cashAmount }
 */
router.post('/redeem', memberAuth, async (req, res) => {
  try {
    const { voucherId, cashAmount } = req.body;

    if (!voucherId || !cashAmount || Number(cashAmount) <= 0) {
      return res.status(400).json({ error: 'Voucher ID and cash amount are required' });
    }

    const result = await redeemVoucher(req.session.uid, Number(voucherId), Number(cashAmount));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Vouchers] Redeem error:', err);
    res.status(400).json({ error: err.message || 'Redemption failed' });
  }
});

module.exports = router;
