/**
 * Admin Encashment Management Routes
 * 1:1 port of PHP adminpanel/accounts-encashment.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

/**
 * GET /api/admin/encashment?page=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&q=keyword
 * List encashment records with optional filters
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 50;
    const offset = (page - 1) * perPage;

    const startDate = (req.query.startDate || '').trim();
    const endDate = (req.query.endDate || '').trim();
    const q = (req.query.q || '').trim();
    const searchLike = `%${q}%`;

    let whereSql = `WHERE (p.transactiontype = 10 OR p.encashment1 > 0)`;
    const whereParams = [];

    if (startDate) {
      whereSql += ` AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') >= ?`;
      whereParams.push(startDate);
    }

    if (endDate) {
      whereSql += ` AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') <= ?`;
      whereParams.push(endDate);
    }

    if (q) {
      whereSql += `
        AND (
          m.username LIKE ?
          OR m.firstname LIKE ?
          OR m.lastname LIKE ?
          OR CONCAT(m.firstname, ' ', m.lastname) LIKE ?
        )
      `;
      whereParams.push(searchLike, searchLike, searchLike, searchLike);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM payouthistorytab p
       LEFT JOIN memberstab m ON m.uid = p.uid
       ${whereSql}`,
      whereParams
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT p.pid, p.uid, DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') as cashtransdate,
              p.cashstatus, p.cddeduction, p.encashment1, p.tax_1, p.encashmentfee,
              m.payoutid, m.payoutdetails, m.username, m.firstname, m.lastname
       FROM payouthistorytab p
       LEFT JOIN memberstab m ON m.uid = p.uid
       ${whereSql}
       ORDER BY p.cashtransdate DESC, p.pid DESC LIMIT ?, ?`,
      [...whereParams, offset, perPage]
    );

    const records = rows.map(r => {
      const tax = Number(r.tax_1 || 0);
      const fee = Number(r.encashmentfee || 0);
      const cdDeduction = Number(r.cddeduction || 0);
      const fullName = `${r.firstname || ''} ${r.lastname || ''}`.trim() || `Unknown Account (UID: ${r.uid})`;
      const payoutDetails = [r.payoutid, r.payoutdetails].filter(Boolean).join(' / ') || 'N/A';

      return {
        pid: r.pid,
        uid: r.uid,
        username: r.username || 'N/A',
        fullname: fullName,
        encashment: Number(r.encashment1 || 0),
        tax,
        fee,
        cdDeduction,
        deductions: tax + fee + cdDeduction,
        cashStatus: r.cashstatus,
        cashStatusLabel: Number(r.cashstatus) === 1 ? 'Paid' : 'Pending',
        payoutId: r.payoutid,
        payoutDetails,
        cashtransdate: r.cashtransdate,
        canViewCdDetails: cdDeduction > 0,
      };
    });

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

    if (!Number.isFinite(pid) || !Number.isFinite(Number(uid))) {
      return res.status(400).json({ error: 'Invalid encashment reference' });
    }

    const [result] = await pool.query(
      "UPDATE payouthistorytab SET cashstatus = 1, cashtransdate = NOW() WHERE pid = ? AND uid = ? LIMIT 1",
      [pid, Number(uid)]
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
