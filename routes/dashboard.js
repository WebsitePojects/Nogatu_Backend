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
const { getPairingCounts } = require('../services/network');
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

    // 4. Get live left/right account counts from the full binary subtree.
    //    getPairingCounts uses binary_tree_closuretab when available and falls
    //    back to recursive usertab traversal — always counts ALL descendants,
    //    not just direct children.
    const pairingCounts = await getPairingCounts(uid);
    const leftAccounts = pairingCounts.totalLeft;
    const rightAccounts = pairingCounts.totalRight;
    // binarypoints in usertab are stored as peso values (250=Bronze, 5000=Garnet, etc.)
    // Divide by 250 to convert to PV units for dashboard display (1 PV = PHP 250 SMB)
    const BP_PESO = 250;
    const leftPoints = Math.round(pairingCounts.totalPointsLeft / BP_PESO);
    const rightPoints = Math.round(pairingCounts.totalPointsRight / BP_PESO);
    const pairingBalance = Math.abs(leftPoints - rightPoints);

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
      // Aggregate by level so the UI can render a clear per-level breakdown
      // with rate, total points contributed, projected commission, and member count.
      const levelMap = {};
      for (const r of productPointTrace.rows) {
        const l = Number(r.level || 0);
        if (!levelMap[l]) {
          levelMap[l] = {
            level: l,
            ratePercent: Number(r.ratePercent || 0),
            totalPoints: 0,
            projectedAmount: 0,
            contributorCount: 0,
            members: [],
          };
        }
        levelMap[l].totalPoints += Number(r.productPoints || 0);
        levelMap[l].projectedAmount += Number(r.projectedAmount || r.amount || 0);
        levelMap[l].contributorCount += 1;
        levelMap[l].members.push({
          uid: r.uid,
          username: r.username,
          fullname: r.fullname,
          productPoints: Number(r.productPoints || 0),
          amount: Number(r.amount || 0),
        });
      }
      const byLevel = Object.values(levelMap).sort((a, b) => a.level - b.level);
      response.rows = [...productPointTrace.rows, ...creditedRows].slice(0, limit);
      response.total = creditedRows.reduce((sum, row) => sum + row.amount, 0);
      response.byLevel = byLevel;
      response.summary = {
        creditedTotal: response.total,
        downlineProductPoints: productPointTrace.totalPoints,
        projectedDownlineAmount: productPointTrace.projectedAmount,
        levelBreakdown: byLevel.map((b) => ({
          level: b.level,
          ratePercent: b.ratePercent,
          totalPoints: b.totalPoints,
          projectedAmount: b.projectedAmount,
          contributorCount: b.contributorCount,
        })),
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
      // Try closure table first for ALL descendants in this leg.
      try {
        const [closureRows] = await pool.query(
          `SELECT c.descendant_uid AS uid, c.depth, c.leg,
                  u.accttype, u.currentaccttype, u.binarypoints, u.datereg,
                  m.username, m.firstname, m.lastname
           FROM binary_tree_closuretab c
           INNER JOIN usertab u ON u.uid = c.descendant_uid
           LEFT JOIN memberstab m ON m.uid = u.uid
           WHERE c.ancestor_uid = ? AND c.depth > 0 AND c.leg = ?
           ORDER BY c.depth ASC, u.datereg ASC
           LIMIT ?`,
          [uid, leg, limit]
        );
        if (closureRows.length > 0) {
          response.formula = `All members in the ${leg} binary subtree (via closure table), ordered by depth.`;
          response.rows = closureRows.map((r) => ({
            uid: Number(r.uid),
            depth: Number(r.depth || 0),
            leg: r.leg,
            currentaccttype: r.currentaccttype,
            binarypoints: r.binarypoints,
            datereg: r.datereg,
            username: r.username,
            fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim(),
          }));
          response.total = closureRows.length;
        } else {
          throw Object.assign(new Error('no closure entries'), { code: '_EMPTY' });
        }
      } catch (closureErr) {
        if (closureErr.code !== 'ER_NO_SUCH_TABLE' && closureErr.code !== '_EMPTY') throw closureErr;
        // Fallback: show direct children only when closure table unavailable/empty
        const position = leg === 'left' ? 1 : 2;
        const [rows] = await pool.query(
          `SELECT u.uid, u.accttype, u.currentaccttype, u.binarypoints, u.datereg,
                  m.username, m.firstname, m.lastname
           FROM usertab u
           LEFT JOIN memberstab m ON m.uid = u.uid
           WHERE u.refid = ? AND u.position = ?
           ORDER BY u.id ASC
           LIMIT ?`,
          [uid, position, limit]
        );
        response.formula = `${leg} direct binary placement only (closure table unavailable or not yet backfilled).`;
        response.rows = rows.map((r) => ({
          uid: Number(r.uid),
          depth: 1,
          leg,
          currentaccttype: r.currentaccttype,
          binarypoints: r.binarypoints,
          datereg: r.datereg,
          username: r.username,
          fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim(),
        }));
        response.total = rows.length;
      }
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
