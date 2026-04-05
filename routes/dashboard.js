/**
 * Dashboard Routes
 * 1:1 port of PHP mydashboard.php data queries
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { getAccountTypeName, currentMonthRange } = require('../utils/helpers');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');

/**
 * GET /api/dashboard
 * Returns all dashboard metrics for the logged-in member.
 * Triggers income calculation first so values are always current —
 * no need to visit the wallet page to see earned income.
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const currentaccttype = req.session.currentaccttype;

    // 1. Calculate any new income and persist it, then read the updated totals.
    //    All income types are idempotent — repeated calls never double-credit.
    const income = await calculateAndStoreIncome(uid, currentaccttype);

    const ttlincome1     = Number(income.ttlincome1     || 0);
    const ttlincome2     = Number(income.ttlincome2     || 0);
    const ttlincome3     = Number(income.ttlincome3     || 0);
    const ttlincome4     = Number(income.ttlincome4     || 0);
    const ttlincome5     = Number(income.ttlincome5     || 0);
    const ttlincome6     = Number(income.ttlincome6     || 0);
    const ttlcashbalance = Number(income.ttlcashbalance || 0);

    // Match production: active cash summary includes income1,2,3,5 only.
    const totalCashIncome = ttlincome1 + ttlincome2 + ttlincome3 + ttlincome5;

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

    const drefByType = {
      Bronze: 0,
      Silver: 0,
      Gold: 0,
      Platinum: 0,
      Garnet: 0,
      Diamond: 0,
    };
    for (const row of drefRows) {
      const typeName = getAccountTypeName(row.currentaccttype);
      drefByType[typeName] = Number(row.cnt);
    }

    // 4. Get latest pairing summary from pairingstab (production chkPairing parity)
    const [pairSummaryRows] = await pool.query(
      `SELECT totalleft, totalpointsleft, totalright, totalpointsright,
              \`left\`, \`right\`, totalpoints
       FROM pairingstab WHERE uid = ?
       ORDER BY id DESC LIMIT 1`,
      [uid]
    );

    let leftAccounts = 0;
    let rightAccounts = 0;
    let leftPoints = 0;
    let rightPoints = 0;
    let pairingBalance = 0;

    if (pairSummaryRows.length > 0) {
      const p = pairSummaryRows[0];
      leftAccounts = Number(p.totalleft || 0);
      rightAccounts = Number(p.totalright || 0);
      // Production dashboard displays these as /250-converted points.
      leftPoints = Number(p.totalpointsleft || 0) / 250;
      rightPoints = Number(p.totalpointsright || 0) / 250;
      pairingBalance = Math.abs(Number(p.left || 0) - Number(p.right || 0));
    } else {
      // Fallback when pairing table has no rows yet.
      const [pairingRows] = await pool.query(
        `SELECT position, COUNT(*) as total
         FROM usertab WHERE refid = ? GROUP BY position`,
        [uid]
      );

      for (const row of pairingRows) {
        if (Number(row.position) === 1) leftAccounts = Number(row.total);
        if (Number(row.position) === 2) rightAccounts = Number(row.total);
      }
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
      leftPoints,
      rightAccounts,
      rightPoints,
      pairingBalance,
      accountType: req.session.caccttype,
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
