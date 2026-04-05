/**
 * Admin Dashboard Routes
 * 1:1 port of PHP adminpanel/admin-dashboard.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

/**
 * GET /api/admin/dashboard
 * Returns admin dashboard metrics
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    // Total members by type (mirrors get_total_members)
    const [memberRows] = await pool.query(
      'SELECT codeid, accttype, COUNT(*) as cnt FROM usertab GROUP BY codeid, accttype'
    );

    let totalPaid = 0, totalFs = 0, totalCd = 0;
    for (const row of memberRows) {
      const codeid = Number(row.codeid || 0);
      if (codeid === 1) totalPaid += Number(row.cnt);
      if (codeid === 2) totalFs += Number(row.cnt);
      if (codeid === 3) totalCd += Number(row.cnt);
    }

    // Total purchases (mirrors get_total_purchases)
    const [purchaseRows] = await pool.query(
      'SELECT SUM(incentivepoints1) as purchases FROM repurchasetab'
    );
    const totalPurchases = Number(purchaseRows[0]?.purchases || 0);

    // Weekly new activations
    const [weeklyRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM usertab
       WHERE datereg >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    const weeklyActivations = Number(weeklyRows[0]?.cnt || 0);

    const [pendingEncashRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM payouthistorytab
       WHERE transactiontype = 10 AND cashstatus = 0`
    );
    const pendingEncashments = Number(pendingEncashRows[0]?.cnt || 0);

    const [paidEncashRows] = await pool.query(
      `SELECT COALESCE(SUM(encashment1), 0) as total FROM payouthistorytab
       WHERE transactiontype = 10 AND cashstatus = 1`
    );
    const totalIncomePaidOut = Number(paidEncashRows[0]?.total || 0);

    const [activeCdRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM usertab
       WHERE codeid = 3 AND cdstatus = 1`
    );
    const activeCdAccounts = Number(activeCdRows[0]?.cnt || 0);

    const [monthRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM usertab
       WHERE MONTH(datereg) = MONTH(NOW()) AND YEAR(datereg) = YEAR(NOW())`
    );
    const newRegistrationsMonth = Number(monthRows[0]?.cnt || 0);

    res.json({
      totalAccounts: totalPaid + totalFs + totalCd,
      paidAccounts: totalPaid,
      freeSlots: totalFs,
      cdSlots: totalCd,
      totalPurchases,
      weeklyActivations,
      totalEncashment: 0, // Hardcoded to 0 as in PHP
      pendingEncashments,
      totalIncomePaidOut,
      activeCdAccounts,
      newRegistrationsMonth,
    });
  } catch (err) {
    console.error('[Admin Dashboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
