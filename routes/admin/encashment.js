/**
 * Admin Encashment Management Routes
 * 1:1 port of PHP adminpanel/accounts-encashment.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

/**
 * GET /api/admin/encashment?page=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * List encashment records with date filtering
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;

    // Default date range: 2 months ago to today
    const now = new Date();
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const startDate = req.query.startDate || twoMonthsAgo.toISOString().slice(0, 10);
    const endDate = req.query.endDate || now.toISOString().slice(0, 10);

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM payouthistorytab p, usertab u, memberstab m
       WHERE m.uid = u.uid AND u.uid = p.uid AND p.transactiontype = 10
       AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') <= ?`,
      [startDate, endDate]
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT p.pid, p.uid, DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') as cashtransdate,
              p.cashstatus, p.cddeduction, p.encashment1, p.tax_1, p.encashmentfee,
              p.transactiontype,
              u.uid as uUid, u.mainid,
              m.payoutid, m.payoutdetails, m.username, m.firstname, m.lastname
       FROM payouthistorytab p, usertab u, memberstab m
       WHERE m.uid = u.uid AND u.uid = p.uid AND p.transactiontype = 10
       AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') <= ?
       ORDER BY p.cashtransdate DESC LIMIT ?, ?`,
      [startDate, endDate, offset, perPage]
    );

    const records = rows.map(r => ({
      pid: r.pid,
      uid: r.uid,
      username: r.username,
      fullname: `${r.firstname} ${r.lastname}`,
      encashment: Number(r.encashment1 || 0),
      tax: Number(r.tax_1 || 0),
      fee: Number(r.encashmentfee || 0),
      cdDeduction: Number(r.cddeduction || 0),
      cashStatus: r.cashstatus,
      cashStatusLabel: r.cashstatus === 1 ? 'Processed' : 'Pending',
      payoutId: r.payoutid,
      payoutDetails: r.payoutdetails,
      cashtransdate: r.cashtransdate,
    }));

    res.json({ records, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[Admin Encashment] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/encashment/:pid/process
 * Mark encashment as processed
 */
router.put('/:pid/process', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const { uid } = req.body;

    const [result] = await pool.query(
      "UPDATE payouthistorytab SET cashstatus = 1, cashtransdate = NOW() WHERE pid = ? AND uid = ? LIMIT 1",
      [pid, uid]
    );

    if (result.affectedRows === 1) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Update failed' });
    }
  } catch (err) {
    console.error('[Admin Encashment] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
