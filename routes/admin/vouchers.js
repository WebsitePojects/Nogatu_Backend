/**
 * Admin Voucher Routes (DOC2 §4.1)
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAllVouchers } = require('../../services/voucher');

/**
 * GET /api/admin/vouchers?page=1
 * Admin view all vouchers
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const result = await getAllVouchers(page);
    res.json(result);
  } catch (err) {
    console.error('[Admin Vouchers] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
