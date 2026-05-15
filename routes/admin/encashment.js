/**
 * Admin Encashment Management Routes
 * 1:1 port of PHP adminpanel/accounts-encashment.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

const PAYOUT_OPTION_LABELS = {
  1: 'Pickup',
  2: 'GCash',
  3: 'Remittance Center',
  4: 'Bank Deposit',
  5: 'Others',
};

const PACKAGE_LABELS = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

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
      const payoutId = Number(r.payoutid || 0);
      const payoutOption = PAYOUT_OPTION_LABELS[payoutId] || 'N/A';
      const payoutDetails = r.payoutdetails
        ? `${payoutOption} / ${r.payoutdetails}`
        : payoutOption;

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
        payoutOption,
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
 * GET /api/admin/encashment/:pid/details?uid=123
 * Full encashment breakdown for modal/receipt preview.
 */
router.get('/:pid/details', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const uidFilter = req.query.uid ? Number(req.query.uid) : null;

    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Invalid encashment reference' });
    }

    const whereUidSql = Number.isFinite(uidFilter) ? 'AND p.uid = ?' : '';
    const params = Number.isFinite(uidFilter) ? [pid, uidFilter] : [pid];

    const [rows] = await pool.query(
      `SELECT p.pid, p.uid,
              DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
              DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
              p.transactiontype, p.cashstatus,
              p.beginningbalance, p.endingbalance,
              p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
              p.encashment1, p.tax_1, p.encashmentfee, p.cddeduction,
              p.paymentoptions, p.paymentdetails,
              m.username, m.firstname, m.lastname, m.payoutid, m.payoutdetails,
              u.currentaccttype
       FROM payouthistorytab p
       LEFT JOIN memberstab m ON m.uid = p.uid
       LEFT JOIN usertab u ON u.uid = p.uid
       WHERE p.pid = ? ${whereUidSql}
       LIMIT 1`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Encashment record not found' });
    }

    const row = rows[0];
    const tax = Number(row.tax_1 || 0);
    const fee = Number(row.encashmentfee || 0);
    const cdDeduction = Number(row.cddeduction || 0);
    const deductions = tax + fee + cdDeduction;
    const netReceivable = Number(row.encashment1 || 0);
    const grossEncashment = Number(row.transactiontype || 0) === 10
      ? netReceivable + deductions
      : 0;

    const income = {
      directReferral: Number(row.income1 || 0),
      pairing: Number(row.income2 || 0),
      leadership: Number(row.income3 || 0),
      unilevel: Number(row.income4 || 0),
      hifive: Number(row.income5 || 0),
      rankingBonus: Number(row.income6 || 0),
      legacyIncome6: Number(row.income6 || 0),
    };

    const payoutId = Number(row.paymentoptions || row.payoutid || 0);
    const paymentOption = PAYOUT_OPTION_LABELS[payoutId] || 'N/A';
    const paymentDetails = row.paymentdetails || row.payoutdetails || null;

    res.json({
      pid: Number(row.pid),
      uid: Number(row.uid),
      username: row.username || 'N/A',
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim() || `UID ${row.uid}`,
      packageType: PACKAGE_LABELS[Number(row.currentaccttype || 0)] || 'Unknown',
      transactionType: Number(row.transactiontype || 0),
      transactionTypeName:
        Number(row.transactiontype || 0) === 10
          ? 'Encashment'
          : Number(row.transactiontype || 0) === 1
            ? 'Income'
            : 'Other',
      status: Number(row.cashstatus || 0),
      statusLabel: Number(row.cashstatus || 0) === 1 ? 'Paid' : 'Pending',
      transdate: row.transdate,
      cashtransdate: row.cashtransdate,
      beginningBalance: Number(row.beginningbalance || 0),
      endingBalance: Number(row.endingbalance || 0),
      income,
      grossEncashment,
      netReceivable,
      deductions: {
        tax,
        fee,
        cdDeduction,
        total: deductions,
      },
      paymentOption,
      paymentOptionId: payoutId || null,
      paymentDetails,
      canViewCdDetails: cdDeduction > 0,
    });
  } catch (err) {
    console.error('[Admin Encashment] Details error:', err);
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
