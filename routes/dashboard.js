/**
 * Dashboard Routes
 * 1:1 port of PHP mydashboard.php data queries
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { getAccountTypeName, currentMonthRange } = require('../utils/helpers');

/**
 * GET /api/dashboard
 * Returns all dashboard metrics for the logged-in member
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;

    // 1. Get income totals from payouttotaltab
    const [incomeRows] = await pool.query(
      `SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6,
              ttlcashbalance FROM payouttotaltab WHERE uid = ?`,
      [uid]
    );

    const income = incomeRows[0] || {};
    const ttlincome1 = Number(income.ttlincome1 || 0);
    const ttlincome2 = Number(income.ttlincome2 || 0);
    const ttlincome3 = Number(income.ttlincome3 || 0);
    const ttlincome4 = Number(income.ttlincome4 || 0);
    const ttlincome5 = Number(income.ttlincome5 || 0);
    const ttlincome6 = Number(income.ttlincome6 || 0);
    const ttlcashbalance = Number(income.ttlcashbalance || 0);

    // Total Cash Income = income1 + income2 + income4 + income5 + income6
    const totalCashIncome = ttlincome1 + ttlincome2 + ttlincome4 + ttlincome5 + ttlincome6;

    // 2. Get maintenance status (current month repurchases)
    const { start, end } = currentMonthRange();
    const [maintRows] = await pool.query(
      `SELECT SUM(incentivepoints1) as ttlpoints
       FROM repurchasetab
       WHERE uid = ? AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
         AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ? AND producttype >= 100`,
      [uid, start, end]
    );
    const maintenancePoints = Number(maintRows[0]?.ttlpoints || 0);
    let maintenanceStatus;
    if (maintenancePoints >= 200) maintenanceStatus = 'Active';
    else if (maintenancePoints === 0) maintenanceStatus = 'Not Active';
    else maintenanceStatus = `${maintenancePoints} pts`;

    // 3. Get direct referral counts by account type
    const [drefRows] = await pool.query(
      `SELECT currentaccttype, COUNT(*) as cnt
       FROM usertab WHERE drefid = ? GROUP BY currentaccttype`,
      [uid]
    );

    const drefByType = {};
    for (const row of drefRows) {
      const typeName = getAccountTypeName(row.currentaccttype);
      drefByType[typeName] = Number(row.cnt);
    }

    // 4. Get pairing (left/right) counts
    const [pairingRows] = await pool.query(
      `SELECT position, COUNT(*) as total
       FROM usertab WHERE refid = ? GROUP BY position`,
      [uid]
    );

    let leftAccounts = 0, rightAccounts = 0;
    for (const row of pairingRows) {
      if (Number(row.position) === 1) leftAccounts = Number(row.total);
      if (Number(row.position) === 2) rightAccounts = Number(row.total);
    }

    res.json({
      totalCashIncome,
      directReferral: ttlincome1,
      salesVolume: ttlincome2,
      uniLevel: ttlincome4,
      leadershipBonus: ttlincome3,
      hiFiveBonus: ttlincome5,
      rankingBonus: ttlincome6,
      cashBalance: ttlcashbalance,
      maintenanceStatus,
      maintenancePoints,
      directReferrals: drefByType,
      leftAccounts,
      rightAccounts,
      accountType: req.session.caccttype,
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
