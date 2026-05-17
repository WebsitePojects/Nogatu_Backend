/**
 * Transaction History Routes
 * 1:1 port of PHP transactions-details.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { ensureVoucherTxTable } = require('../services/voucher');

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

    await ensureVoucherTxTable();

    const [[incomeCountRows], [voucherCountRows]] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM payouthistorytab WHERE uid = ?', [uid]),
      pool.query('SELECT COUNT(*) as total FROM voucher_transactionstab WHERE uid = ?', [uid]),
    ]);

    const totalIncomeRows = Number(incomeCountRows[0]?.total || 0);
    const totalVoucherRows = Number(voucherCountRows[0]?.total || 0);
    const total = totalIncomeRows + totalVoucherRows;

    const [rows] = await pool.query(
      `SELECT t.pid, t.uid, t.beginningbalance, t.endingbalance,
              t.income1, t.income2, t.income3, t.income4, t.income5, t.income6,
              t.encashment1, t.tax, t.fee, t.cddeduction,
              t.cashstatus, t.cashtransdate, t.transdate,
              t.transactiontype,
              t.cash_paid, t.voucher_used, t.total_value, t.voucher_id
       FROM (
         SELECT CAST(p.pid AS CHAR) AS pid,
                p.uid,
                p.beginningbalance,
                p.endingbalance,
                p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
                p.encashment1,
                p.tax_1 AS tax,
                p.encashmentfee AS fee,
                p.cddeduction,
                p.cashstatus,
                DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
                p.transactiontype,
                0 AS cash_paid,
                0 AS voucher_used,
                0 AS total_value,
                0 AS voucher_id,
                COALESCE(p.transdate, p.cashtransdate) AS sort_date,
                p.pid AS sort_id
         FROM payouthistorytab p
         WHERE p.uid = ?

         UNION ALL

         SELECT CONCAT('V-', vt.id) AS pid,
                vt.uid,
                0 AS beginningbalance,
                0 AS endingbalance,
                0 AS income1,
                0 AS income2,
                0 AS income3,
                0 AS income4,
                0 AS income5,
                0 AS income6,
                0 AS encashment1,
                0 AS tax,
                0 AS fee,
                0 AS cddeduction,
                0 AS cashstatus,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS transdate,
                11 AS transactiontype,
                vt.cash_paid,
                vt.voucher_used,
                vt.total_value,
                vt.voucher_id,
                vt.transaction_date AS sort_date,
                vt.id AS sort_id
         FROM voucher_transactionstab vt
         WHERE vt.uid = ?
       ) t
       ORDER BY t.sort_date DESC, t.sort_id DESC
       LIMIT ?, ?`,
      [uid, uid, offset, perPage]
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
      rankingBonus: Number(r.income6 || 0),
      legacyIncome6: Number(r.income6 || 0),
      encashment: Number(r.encashment1 || 0),
      tax: Number(r.tax || 0),
      fee: Number(r.fee || 0),
      cdDeduction: Number(r.cddeduction || 0),
      cashPaid: Number(r.cash_paid || 0),
      voucherUsed: Number(r.voucher_used || 0),
      totalProductValue: Number(r.total_value || 0),
      voucherId: Number(r.voucher_id || 0),
      deductions: Number(r.tax || 0) + Number(r.fee || 0) + Number(r.cddeduction || 0),
      cashStatus: Number(r.cashstatus || 0),
      transactionType: Number(r.transactiontype || 0),
      transactionTypeName:
        Number(r.transactiontype || 0) === 1
          ? 'Income'
          : Number(r.transactiontype || 0) === 10
            ? 'Encashment'
            : Number(r.transactiontype || 0) === 11
              ? 'Voucher'
            : 'Other',
      transdate: r.transdate,
      cashtransdate: r.cashtransdate,
    }));

    res.json({
      transactions,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error('[Transactions] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
