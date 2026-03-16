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
      if (row.codeid === 1) totalPaid += Number(row.cnt);
      if (row.codeid === 2) totalFs += Number(row.cnt);
      if (row.codeid === 3) totalCd += Number(row.cnt);
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

    res.json({
      totalAccounts: totalPaid + totalFs + totalCd,
      paidAccounts: totalPaid,
      freeSlots: totalFs,
      cdSlots: totalCd,
      totalPurchases,
      weeklyActivations,
      totalEncashment: 0, // Hardcoded to 0 as in PHP
    });
  } catch (err) {
    console.error('[Admin Dashboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
