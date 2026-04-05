/**
 * Transaction History Routes
 * 1:1 port of PHP transactions-details.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');

/**
 * GET /api/transactions?page=1
 * Get transaction history for logged-in member
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;

    const [countRows] = await pool.query(
      'SELECT COUNT(*) as total FROM payouthistorytab WHERE uid = ?',
      [uid]
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT pid, uid, beginningbalance, endingbalance, cashbalance,
              income1, income2, income3, income4, income5, income6,
              encashment1, tax_1 AS tax, encashmentfee AS fee, cddeduction,
              cashstatus, DATE_FORMAT(cashtransdate, '%Y-%m-%d %H:%i') as cashtransdate,
              DATE_FORMAT(transdate, '%Y-%m-%d %H:%i') as transdate,
              transactiontype
       FROM payouthistorytab WHERE uid = ?
       ORDER BY pid DESC LIMIT ?, ?`,
      [uid, offset, perPage]
    );

    const transactions = rows.map(r => ({
      pid: r.pid,
      beginningBalance: Number(r.beginningbalance || 0),
      endingBalance: Number(r.endingbalance || 0),
      directReferral: Number(r.income1 || 0),
      pairing: Number(r.income2 || 0),
      leadership: Number(r.income3 || 0),
      unilevel: Number(r.income4 || 0),
      hifive: Number(r.income5 || 0),
      lpc: Number(r.income6 || 0),
      encashment: Number(r.encashment1 || 0),
      tax: Number(r.tax || 0),
      fee: Number(r.fee || 0),
      cdDeduction: Number(r.cddeduction || 0),
      deductions: Number(r.tax || 0) + Number(r.fee || 0) + Number(r.cddeduction || 0),
      cashStatus: Number(r.cashstatus || 0),
      transactionType: Number(r.transactiontype || 0),
      transactionTypeName:
        Number(r.transactiontype || 0) === 1
          ? 'Income'
          : Number(r.transactiontype || 0) === 10
            ? 'Encashment'
            : 'Other',
      transdate: r.transdate,
      cashtransdate: r.cashtransdate,
    }));

    res.json({
      transactions,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (err) {
    console.error('[Transactions] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
