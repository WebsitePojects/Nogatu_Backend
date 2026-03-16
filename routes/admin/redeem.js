/**
 * Admin Redemption Management Routes
 * 1:1 port of PHP adminpanel/accounts-redeem.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { PRODUCT_TYPES } = require('../../utils/helpers');

/**
 * GET /api/admin/redeem?page=1&startDate=&endDate=
 * List Hi-Five redemption records
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;

    const now = new Date();
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const startDate = req.query.startDate || twoMonthsAgo.toISOString().slice(0, 10);
    const endDate = req.query.endDate || now.toISOString().slice(0, 10);

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM h5historytab h, usertab u, memberstab m
       WHERE m.uid = u.uid AND u.uid = h.uid
       AND DATE_FORMAT(h.redeemdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(h.redeemdate, '%Y-%m-%d') <= ?`,
      [startDate, endDate]
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT h.pid, h.uid, h.ttlbonus, h.producttype, h.redeemstatus,
              DATE_FORMAT(h.redeemdate, '%Y-%m-%d') as redeemdate,
              u.uid as uUid, u.mainid,
              m.username, m.firstname, m.lastname
       FROM h5historytab h, usertab u, memberstab m
       WHERE m.uid = u.uid AND u.uid = h.uid
       AND DATE_FORMAT(h.redeemdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(h.redeemdate, '%Y-%m-%d') <= ?
       ORDER BY h.pid DESC LIMIT ?, ?`,
      [startDate, endDate, offset, perPage]
    );

    const records = rows.map(r => ({
      pid: r.pid,
      uid: r.uid,
      username: r.username,
      fullname: `${r.firstname} ${r.lastname}`,
      totalBonus: Number(r.ttlbonus || 0),
      producttype: r.producttype,
      producttypeName: PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
      redeemStatus: r.redeemstatus,
      redeemStatusLabel: r.redeemstatus === 1 ? 'Redeemed' : 'Pending',
      redeemdate: r.redeemdate,
    }));

    res.json({ records, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[Admin Redeem] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/redeem/:pid/process
 * Mark redemption as redeemed
 */
router.put('/:pid/process', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const { uid } = req.body;

    const [result] = await pool.query(
      "UPDATE h5historytab SET redeemstatus = 1, redeemdate = NOW() WHERE pid = ? AND uid = ? LIMIT 1",
      [pid, uid]
    );

    res.json({ success: result.affectedRows === 1 });
  } catch (err) {
    console.error('[Admin Redeem] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
