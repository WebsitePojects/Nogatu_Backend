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
const {
  getProjectedCurrentMonthUnilevel,
  getUnilevelProductPointContributors,
} = require('../services/income/unilevel');
const { getLeadershipTraceability } = require('../services/income/leadership');
const {
  getEffectiveAccountState,
  getAccountEntryAuditInfo,
} = require('../services/accountState');
const {
  buildSectionedCsv,
  sendCsv,
} = require('../services/csvExport');

async function buildLeadershipBreakdown(uid, page = 1, perPage = 50) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Number(perPage) || 50));
  const trace = await getLeadershipTraceability(uid);
  const [directCountRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM usertab WHERE drefid = ?',
    [uid]
  );

  const allRows = trace.rows.map((row) => ({
    uid: row.uid,
    username: row.username,
    fullname: row.fullName,
    level: row.level,
    ratePercent: row.ratePercent,
    pairingIncome: row.pairingIncome,
    amount: row.leadershipBonus,
    directReferralCount: row.directReferralCount,
  }));
  const levelRows = [...allRows].sort((left, right) =>
    Number(left.level || 0) - Number(right.level || 0)
    || String(left.fullname || left.username || '').localeCompare(String(right.fullname || right.username || ''))
    || Number(left.uid || 0) - Number(right.uid || 0)
  );
  const total = allRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalPages = Math.max(1, Math.ceil(allRows.length / safePerPage));
  const offset = (safePage - 1) * safePerPage;
  const rows = allRows.slice(offset, offset + safePerPage);

  return {
    formula: 'Leadership bonus is 5% of level 1 pairing income, 2% of level 2, and 1% of levels 3 to 5.',
    rows,
    total,
    page: safePage,
    perPage: safePerPage,
    totalRows: allRows.length,
    totalPages,
    summary: {
      totalSources: trace.totalSources,
      directReferralCount: Number(directCountRows[0]?.total || 0),
      byLevel: trace.byLevel,
    },
    levelRows,
  };
}

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
    const projectedUnilevelReceivable = await getProjectedCurrentMonthUnilevel(uid);
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
      unilevelMaintenance: {
        requiredPoints: 200,
        currentPoints: maintenancePoints,
        neededPoints: Math.max(0, 200 - maintenancePoints),
        eligible: maintenancePoints >= 200,
        receivableAmount: maintenancePoints >= 200 ? Number(projectedUnilevelReceivable || 0) : 0,
        blockedAmount: maintenancePoints >= 200 ? 0 : Number(projectedUnilevelReceivable || 0),
      },
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

router.get('/breakdown/:metric', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const metric = String(req.params.metric || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(1, Number(req.query.perPage) || 50));

    const response = {
      metric,
      asOf: new Date().toISOString(),
      total: 0,
      formula: '',
      rows: [],
    };

    if (['total-cash-incentives', 'totalcashincentives'].includes(metric)) {
      const [rows] = await pool.query(
        `SELECT pid, income1, income2, income3, income5, transdate, processid
         FROM payouthistorytab
         WHERE uid = ? AND transactiontype = 1
         ORDER BY transdate DESC, pid DESC
         LIMIT ?`,
        [uid, limit]
      );
      response.formula = 'Direct Referral + Sales Volume (Pairing) + Leadership Bonus + Hi-Five Bonus';
      response.rows = rows.map((row) => ({
        pid: row.pid,
        directReferral: Number(row.income1 || 0),
        salesVolume: Number(row.income2 || 0),
        leadershipBonus: Number(row.income3 || 0),
        hiFiveBonus: Number(row.income5 || 0),
        total: Number(row.income1 || 0) + Number(row.income2 || 0) + Number(row.income3 || 0) + Number(row.income5 || 0),
        transdate: row.transdate,
        processKey: row.processid,
      }));
      response.total = response.rows.reduce((sum, row) => sum + row.total, 0);
    } else if (['current-cash-balance', 'cashbalance'].includes(metric)) {
      const [rows] = await pool.query(
        `SELECT ttlcashbalance, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6, transdate
         FROM payouttotaltab
         WHERE uid = ?
         LIMIT 1`,
        [uid]
      );
      const row = rows[0] || {};
      response.formula = 'Legacy balance from payouttotaltab, protected by transaction locks during new encashments.';
      response.total = Number(row.ttlcashbalance || 0);
      response.rows = [row];
    } else if (['direct-referral', 'directreferral'].includes(metric)) {
      const [rows, upgradeRows] = await Promise.all([
        pool.query(
          `SELECT u.uid AS referred_uid, u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
                  u.directreferral, u.datereg, m.username, m.firstname, m.lastname
           FROM usertab u
           LEFT JOIN memberstab m ON m.uid = u.uid
           WHERE u.drefid = ?
           ORDER BY u.datereg DESC, u.uid DESC
           LIMIT ?`,
          [uid, limit]
        ).then(([result]) => result),
        pool.query(
          `SELECT u.uid AS referred_uid, u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
                  m.username, m.firstname, m.lastname,
                  COALESCE(SUM(up.incentivepoints), 0) AS upgradeReferral,
                  MAX(up.transdate) AS transdate
           FROM upgradetab up
           INNER JOIN usertab u ON u.uid = up.uid
           LEFT JOIN memberstab m ON m.uid = u.uid
           WHERE u.drefid = ? AND up.transtype = 1
           GROUP BY u.uid, u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
                    m.username, m.firstname, m.lastname
           ORDER BY MAX(up.transdate) DESC, u.uid DESC
           LIMIT ?`,
          [uid, limit]
        ).then(([result]) => result),
      ]);
      response.formula = 'Direct referral contributor rows based on the referred account entry type plus any credited upgrade incentive from the sponsor tree.';
      const contributorRows = await Promise.all(rows.map(async (row) => {
        const effectiveRow = await getEffectiveAccountState(row.referred_uid, row);
        const auditInfo = getAccountEntryAuditInfo(effectiveRow || row);
        return {
          referred_uid: Number(row.referred_uid || 0),
          username: row.username || null,
          fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim() || row.username || 'Not available',
          accountType: getAccountTypeName(effectiveRow?.currentaccttype || row.currentaccttype),
          entryType: auditInfo.entryLabel,
          entryCode: auditInfo.entryCode,
          sponsorCreditEligible: Boolean(auditInfo.sponsorCreditEligible),
          sourceBinaryEligible: Boolean(auditInfo.sourceBinaryEligible),
          amount: Number(effectiveRow?.directreferral || row.directreferral || 0),
          transdate: row.datereg,
          rowType: 'referral_signup',
        };
      }));
      const upgradeContributorRows = await Promise.all(upgradeRows.map(async (row) => {
        const effectiveRow = await getEffectiveAccountState(row.referred_uid, row);
        const auditInfo = getAccountEntryAuditInfo(effectiveRow || row);
        return {
          referred_uid: Number(row.referred_uid || 0),
          username: row.username || null,
          fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim() || row.username || 'Not available',
          accountType: getAccountTypeName(effectiveRow?.currentaccttype || row.currentaccttype),
          entryType: auditInfo.entryLabel,
          entryCode: auditInfo.entryCode,
          sponsorCreditEligible: Boolean(auditInfo.sponsorCreditEligible),
          sourceBinaryEligible: Boolean(auditInfo.sourceBinaryEligible),
          amount: Number(row.upgradeReferral || 0),
          transdate: row.transdate,
          rowType: 'upgrade_incentive',
        };
      }));
      response.rows = [...contributorRows, ...upgradeContributorRows]
        .filter((row) => {
          if (Number(row.amount || 0) <= 0) {
            return false;
          }

          if (row.rowType === 'referral_signup') {
            return Boolean(row.sponsorCreditEligible);
          }

          return true;
        })
        .sort((left, right) => new Date(right.transdate || 0) - new Date(left.transdate || 0))
        .slice(0, limit);
      response.total = response.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    } else if (['sales-volume', 'pairing', 'pairing-balance', 'salesvolume'].includes(metric)) {
      const [rows] = await pool.query(
        `SELECT id, totalleft, totalright, totalpointsleft, totalpointsright,
                \`left\` AS left_balance, \`right\` AS right_balance, paircount, pairamount, flushout, transdate
         FROM pairingstab
         WHERE uid = ?
         ORDER BY id DESC
         LIMIT ?`,
        [uid, limit]
      );
      response.formula = 'Pairing rows from pairingstab; balance is absolute left/right carry difference.';
      response.rows = rows.map((row) => ({
        ...row,
        totalleft: Number(row.totalleft || 0),
        totalright: Number(row.totalright || 0),
        totalpointsleft: Number(row.totalpointsleft || 0),
        totalpointsright: Number(row.totalpointsright || 0),
        left_balance: Number(row.left_balance || 0),
        right_balance: Number(row.right_balance || 0),
        paircount: Number(row.paircount || 0),
        pairamount: Number(row.pairamount || 0),
        flushout: Number(row.flushout || 0),
      }));
      response.total = response.rows.reduce((sum, row) => sum + row.pairamount, 0);
    } else if (['uni-level', 'unilevel'].includes(metric)) {
      const { start, end } = currentMonthRange();
      const [maintRows] = await pool.query(
        `SELECT SUM(incentivepoints1) as ttlpoints
         FROM repurchasetab
         WHERE uid = ? AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
           AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ? AND producttype >= 100`,
        [uid, start, end]
      );
      const [incomeRows] = await pool.query(
        `SELECT pid, income4 AS amount, transdate, processid
         FROM payouthistorytab
         WHERE uid = ? AND income4 > 0
         ORDER BY transdate DESC, pid DESC
         LIMIT ?`,
        [uid, limit]
      );
      const productPointTrace = await getUnilevelProductPointContributors(uid, { start, end });
      const points = Number(maintRows[0]?.ttlpoints || 0);
      response.formula = 'Unilevel requires at least 200 own product points in the current month; downline product-point rows show the members and purchases that can create unilevel value.';
      response.eligibility = {
        requiredPoints: 200,
        currentPoints: points,
        neededPoints: Math.max(0, 200 - points),
        eligible: points >= 200,
        downlineProductPoints: productPointTrace.totalPoints,
        projectedDownlineAmount: productPointTrace.projectedAmount,
        packageReach: productPointTrace.maxReach,
      };
      const creditedRows = incomeRows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0),
        rowType: 'credited_unilevel_payout',
      }));
      response.rows = [...productPointTrace.rows, ...creditedRows].slice(0, limit);
      response.total = creditedRows.reduce((sum, row) => sum + row.amount, 0);
      response.summary = {
        creditedTotal: response.total,
        downlineProductPoints: productPointTrace.totalPoints,
        projectedDownlineAmount: productPointTrace.projectedAmount,
      };
    } else if (metric === 'leadership-bonus') {
      const leadership = await buildLeadershipBreakdown(uid, page, perPage);
      response.formula = leadership.formula;
      response.rows = leadership.rows;
      response.total = leadership.total;
      response.summary = leadership.summary;
      response.levelRows = leadership.levelRows || [];
      response.pagination = {
        page: leadership.page,
        perPage: leadership.perPage,
        totalRows: leadership.totalRows,
        totalPages: leadership.totalPages,
      };
    } else if (['hifive-bonus', 'hi-five-bonus', 'ranking-bonus'].includes(metric)) {
      const incomeColumn = metric.includes('ranking') ? 'income6' : 'income5';
      const [rows] = await pool.query(
        `SELECT pid, ${incomeColumn} AS amount, transdate, processid
         FROM payouthistorytab
         WHERE uid = ? AND ${incomeColumn} > 0
        ORDER BY transdate DESC, pid DESC
        LIMIT ?`,
        [uid, limit]
      );
      response.formula = metric.includes('ranking')
        ? 'Credited ranking bonus entries from payout history with positive released amounts.'
        : 'Credited Hi-Five bonus entries from payout history with positive released amounts.';
      response.rows = rows.map((row) => ({ ...row, amount: Number(row.amount || 0) }));
      response.total = response.rows.reduce((sum, row) => sum + row.amount, 0);
    } else if (['left-accounts', 'right-accounts'].includes(metric)) {
      const leg = metric.startsWith('left') ? 'left' : 'right';
      const position = leg === 'left' ? 1 : 2;
      const [rows] = await pool.query(
        `SELECT u.uid, u.public_uid, u.currentaccttype, u.binarypoints, u.datereg,
                m.username, m.firstname, m.lastname
         FROM usertab u
         LEFT JOIN memberstab m ON m.uid = u.uid
         WHERE u.refid = ? AND u.position = ?
         ORDER BY u.id ASC
         LIMIT ?`,
        [uid, position, limit]
      );
      response.formula = `${leg} direct binary placement rows under the current member.`;
      response.rows = rows;
      response.total = rows.length;
    } else {
      return res.status(404).json({ error: 'Unknown dashboard metric.' });
    }

    res.json(response);
  } catch (err) {
    console.error('[Dashboard] Breakdown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/breakdown/:metric/export', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const metric = String(req.params.metric || '').trim().toLowerCase();

    if (metric !== 'leadership-bonus') {
      return res.status(400).json({ error: 'Export is only available for leadership bonus right now.' });
    }

    const leadership = await buildLeadershipBreakdown(uid, 1, 5000);
    const exportRows = leadership.rows.map((row, index) => ({
      '#': index + 1,
      Username: row.username || '',
      Fullname: row.fullname || '',
      Level: Number(row.level || 0),
      RatePercent: Number(row.ratePercent || 0),
      PairingIncome: Number(row.pairingIncome || 0),
      LeadershipBonus: Number(row.amount || 0),
      DirectReferrals: Number(row.directReferralCount || 0),
    }));
    exportRows.push({
      '#': '',
      Username: '',
      Fullname: 'OVERALL TOTAL',
      Level: '',
      RatePercent: '',
      PairingIncome: '',
      LeadershipBonus: Number(leadership.total || 0),
      DirectReferrals: '',
    });

    const csv = buildSectionedCsv([
      {
        title: 'Leadership Bonus',
        rows: exportRows,
      },
    ]);
    sendCsv(res, 'leadership-bonus-breakdown', csv);
  } catch (err) {
    console.error('[Dashboard] Breakdown export error:', err);
    res.status(500).json({ error: 'Unable to export the breakdown right now.' });
  }
});

module.exports = router;
