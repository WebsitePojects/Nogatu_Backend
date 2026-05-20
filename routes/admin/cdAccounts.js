/**
 * Admin CD Account Management Routes
 * Lists CD accounts with payment progress, drilldown metrics, and export surfaces.
 */
const express = require('express');
const XLSX = require('xlsx');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  buildCdPackageBreakdown,
  buildCdExportRows,
} = require('../../services/adminReporting');
const { deriveCdSettlementState } = require('../../services/cdAccountsPolicy');
const {
  renderAdminPdfReport,
  sendPdfReport,
} = require('../../services/jsreportExport');

const PACKAGE_MAP = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

const FULLY_PAID_SQL = `(COALESCE(u.cdstatus, 0) = 2)`;
const STILL_PAYING_SQL = `(COALESCE(u.cdstatus, 0) <> 2)`;
const CD_FROM_SQL = `
  FROM usertab u
  JOIN memberstab m ON m.uid = u.uid
  LEFT JOIN (
    SELECT
      uid,
      SUM(CASE WHEN cddeduction > 0 THEN 1 ELSE 0 END) AS deductionCount,
      SUM(CASE WHEN encashment1 > 0 THEN 1 ELSE 0 END) AS encashmentCount,
      COALESCE(SUM(encashment1), 0) AS netEncashment,
      COALESCE(SUM(cddeduction), 0) AS totalCdDeduction,
      MIN(CASE WHEN cddeduction > 0 THEN cashtransdate END) AS firstDeductionDate,
      MAX(CASE WHEN cddeduction > 0 THEN cashtransdate END) AS lastDeductionDate
    FROM payouthistorytab
    GROUP BY uid
  ) ph ON ph.uid = u.uid
`;

function buildCdWhereClause({ search = '', status = 'all', packageType = 'all' }) {
  let whereClause = 'WHERE u.codeid = 3 AND m.uid = u.uid AND u.uid = u.mainid';
  const params = [];

  if (status === 'paid') {
    whereClause += ` AND ${FULLY_PAID_SQL}`;
  } else if (status === 'unpaid') {
    whereClause += ` AND ${STILL_PAYING_SQL}`;
  }

  if (packageType !== 'all' && Number.isFinite(Number(packageType))) {
    whereClause += ' AND u.currentaccttype = ?';
    params.push(Number(packageType));
  }

  if (search) {
    const pattern = `%${search}%`;
    whereClause += ' AND (m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ? OR CONCAT(m.firstname, \' \', m.lastname) LIKE ?)';
    params.push(pattern, pattern, pattern, pattern);
  }

  return { whereClause, params };
}

function mapCdAccountRow(r) {
  const cdamount = Number(r.cdamount || 0);
  const cdtotal = Number(r.cdtotal || 0);
  const settlementState = deriveCdSettlementState(r);
  const remaining = settlementState.remaining;
  const progress = cdamount > 0 ? Math.min(100, Math.round((cdtotal / cdamount) * 100)) : 0;
  const fullname = `${r.firstname || ''} ${r.lastname || ''}`.trim();

  return {
    uid: Number(r.uid),
    username: r.username,
    firstname: r.firstname,
    lastname: r.lastname,
    fullname,
    package: PACKAGE_MAP[Number(r.currentaccttype || 0)] || `Type ${r.currentaccttype}`,
    accttype: Number(r.currentaccttype || 0),
    currentaccttype: Number(r.currentaccttype || 0),
    codeid: Number(r.codeid || 0),
    cdstatus: Number(r.cdstatus || 0),
    cdstatusLabel: settlementState.statusLabel,
    cdamount,
    cdtotal,
    remaining,
    recoveredRemaining: settlementState.recoveredRemaining,
    progress,
    isRecoveredFullyPaid: settlementState.isRecoveredFullyPaid,
    isCdStatusPaid: Number(r.cdstatus || 0) === 2,
    isSettledOutsideDeduction: settlementState.isSettledOutsideDeduction,
    datereg: r.regdate,
    regdate: r.regdate,
    deductionCount: Number(r.deductionCount || 0),
    encashmentCount: Number(r.encashmentCount || 0),
    netEncashment: Number(r.netEncashment || 0),
    totalCdDeduction: Number(r.totalCdDeduction || 0),
    firstDeductionDate: r.firstDeductionDate || null,
    lastDeductionDate: r.lastDeductionDate || null,
  };
}

async function fetchCdAccounts({ whereClause, params, offset = null, limit = null }) {
  const paginationSql = Number.isFinite(offset) && Number.isFinite(limit) ? 'LIMIT ?, ?' : '';
  const queryParams = Number.isFinite(offset) && Number.isFinite(limit)
    ? [...params, offset, limit]
    : params;

  const [rows] = await pool.query(
    `
      SELECT
        m.uid, m.username, m.firstname, m.lastname,
        u.currentaccttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
        DATE_FORMAT(u.datereg, '%Y-%m-%d') AS regdate,
        COALESCE(ph.deductionCount, 0) AS deductionCount,
        COALESCE(ph.encashmentCount, 0) AS encashmentCount,
        COALESCE(ph.netEncashment, 0) AS netEncashment,
        COALESCE(ph.totalCdDeduction, 0) AS totalCdDeduction,
        DATE_FORMAT(ph.firstDeductionDate, '%Y-%m-%d') AS firstDeductionDate,
        DATE_FORMAT(ph.lastDeductionDate, '%Y-%m-%d') AS lastDeductionDate
      ${CD_FROM_SQL}
      ${whereClause}
      ORDER BY u.datereg DESC, m.uid DESC
      ${paginationSql}
    `,
    queryParams
  );

  return rows.map(mapCdAccountRow);
}

function addSheet(workbook, name, rows, widths = []) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  if (widths.length) {
    sheet['!cols'] = widths.map((wch) => ({ wch }));
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function writeWorkbook(res, filename, sheets, format = 'xlsx') {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    addSheet(workbook, name, rows.rows, rows.widths || []);
  }

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buffer);
}

function money(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildCdPdfDefinition(accounts, packageBreakdown, stats, filters) {
  const packageScale = Math.max(1, ...packageBreakdown.map((row) => Number(row.totalCdAmount || 0)));
  const progressBuckets = [
    { label: 'Fully Paid', value: Number(stats.fullyPaid || 0), color: '#15803d' },
    { label: 'Still Paying', value: Number(stats.stillPaying || 0), color: '#d97706' },
  ];
  const progressScale = Math.max(1, ...progressBuckets.map((row) => row.value));
  return {
    fileName: `cd-accounts-${filters.status}-${filters.packageType}`,
    title: 'CD Account Management Report',
    subtitle: 'Recovered-CD tracking, package breakdown, and payment-progress audit for CD accounts.',
    generatedAt: new Date().toLocaleString('en-PH', { hour12: true }),
    filterChips: [
      `Search: ${filters.search || 'All accounts'}`,
      `Status: ${filters.status || 'all'}`,
      `Package: ${filters.packageType || 'all'}`,
    ],
    summaryCards: [
      { label: 'Total CD Accounts', value: String(stats.total || 0), color: '#b45309' },
      { label: 'Fully Paid', value: String(stats.fullyPaid || 0), color: '#15803d' },
      { label: 'Still Paying', value: String(stats.stillPaying || 0), color: '#d97706' },
      { label: 'Total CD Amount', value: money(stats.totalCdAmount), color: '#dc2626' },
      { label: 'Total Paid', value: money(stats.totalPaid), color: '#047857' },
      { label: 'CD Deductions', value: money(stats.totalCdDeduction), color: '#db2777' },
      { label: 'Net Encashment', value: money(stats.totalNetEncashment), color: '#1d4ed8' },
    ],
    charts: [
      {
        title: 'CD Package Exposure',
        note: 'Total CD amount grouped by package under the current filter.',
        bars: packageBreakdown.map((row) => ({
          label: row.package,
          valueLabel: money(row.totalCdAmount),
          percent: Math.max(4, Math.round((Number(row.totalCdAmount || 0) / packageScale) * 100)),
          color: '#d4af37',
        })),
      },
      {
        title: 'Settlement Status Mix',
        note: 'Recovered fully-paid versus still-paying CD accounts.',
        bars: progressBuckets.map((row) => ({
          label: row.label,
          valueLabel: String(row.value),
          percent: Math.max(4, Math.round((row.value / progressScale) * 100)),
          color: row.color,
        })),
      },
    ],
    tables: [
      {
        title: 'Package Breakdown',
        note: 'Fully Paid counts only accounts whose CD deduction recovery reached the full CD amount.',
        columns: ['Package', 'Accounts', 'Fully Paid', 'Still Paying', 'CD Amount', 'Paid', 'Remaining', 'Net Encashment'],
        rows: packageBreakdown.map((row) => ([
          row.package,
          String(row.totalAccounts || 0),
          String(row.fullyPaid || 0),
          String(row.stillPaying || 0),
          money(row.totalCdAmount),
          money(row.totalPaid),
          money(row.totalRemaining),
          money(row.totalNetEncashment),
        ])),
      },
      {
        title: 'CD Accounts',
        note: 'Accounts settled outside direct deduction remain visible with their own status instead of inflating recovered fully-paid counts.',
        columns: ['Username', 'Full Name', 'Package', 'Status', 'CD Amount', 'Paid', 'Remaining', 'Progress', 'CD Logs', 'Net Encashment'],
        rows: accounts.map((account) => ([
          account.username,
          account.fullname,
          account.package,
          account.cdstatusLabel,
          money(account.cdamount),
          money(account.cdtotal),
          money(account.remaining),
          `${account.progress}%`,
          `${account.deductionCount} deductions / ${account.encashmentCount} encashments`,
          money(account.netEncashment),
        ])),
      },
    ],
  };
}

router.get('/export', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').trim();
    const packageType = String(req.query.packageType || 'all').trim();
    const rawFormat = String(req.query.format || 'xlsx').toLowerCase();
    const format = rawFormat === 'pdf' || rawFormat === 'crystal' ? rawFormat : 'xlsx';
    const filters = { search, status, packageType };
    const { whereClause, params } = buildCdWhereClause(filters);
    const accounts = await fetchCdAccounts({ whereClause, params });
    const packageBreakdown = buildCdPackageBreakdown(accounts);
    const stats = accounts.reduce((acc, account) => {
      acc.total += 1;
      if (account.isCdStatusPaid) acc.fullyPaid += 1;
      else acc.stillPaying += 1;
      acc.totalCdAmount += account.cdamount;
      acc.totalPaid += account.cdtotal;
      acc.totalCdDeduction += account.totalCdDeduction;
      acc.totalNetEncashment += account.netEncashment;
      return acc;
    }, {
      total: 0,
      fullyPaid: 0,
      stillPaying: 0,
      totalCdAmount: 0,
      totalPaid: 0,
      totalCdDeduction: 0,
      totalNetEncashment: 0,
    });

    if (format === 'pdf' || format === 'crystal') {
      const report = await renderAdminPdfReport(buildCdPdfDefinition(accounts, packageBreakdown, stats, filters));
      sendPdfReport(res, report);
      return;
    }

    writeWorkbook(
      res,
      `cd-accounts-${status}-${packageType}`,
      [
        ['Summary', {
          rows: [
            { Metric: 'Search', Value: search || 'All records' },
            { Metric: 'Status Filter', Value: status },
            { Metric: 'Package Filter', Value: packageType },
            { Metric: 'Total CD Accounts', Value: stats.total },
            { Metric: 'Fully Paid', Value: stats.fullyPaid },
            { Metric: 'Still Paying', Value: stats.stillPaying },
            { Metric: 'Total CD Amount', Value: stats.totalCdAmount },
            { Metric: 'Total Paid So Far', Value: stats.totalPaid },
            { Metric: 'CD Deductions', Value: stats.totalCdDeduction },
            { Metric: 'Net Encashment', Value: stats.totalNetEncashment },
          ],
          widths: [26, 20],
        }],
        ['CD Accounts', {
          rows: buildCdExportRows(accounts),
          widths: [16, 24, 14, 14, 14, 14, 14, 12, 18, 16, 20, 18, 18],
        }],
        ['Package Breakdown', {
          rows: packageBreakdown.map((row) => ({
            Package: row.package,
            'Total Accounts': row.totalAccounts,
            'Fully Paid': row.fullyPaid,
            'Still Paying': row.stillPaying,
            'Total CD Amount': row.totalCdAmount,
            'Total Paid': row.totalPaid,
            'Total Remaining': row.totalRemaining,
            'CD Deduction Count': row.totalDeductionCount,
            'Encashment Count': row.totalEncashmentCount,
            'Net Encashment Recovered': row.totalNetEncashment,
          })),
          widths: [14, 14, 12, 12, 18, 14, 18, 18, 18, 22],
        }],
      ],
      format
    );
  } catch (err) {
    console.error('[Admin CD Accounts] Export error:', err);
    res.status(500).json({ success: false, message: 'Failed to export CD accounts' });
  }
});

/**
 * GET /api/admin/cd-accounts?page=1&search=username&status=all|paid|unpaid&packageType=all|10|...
 * List all CD accounts with pagination and summary stats
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').trim();
    const packageType = String(req.query.packageType || 'all').trim();

    const filters = { search, status, packageType };
    const { whereClause, params } = buildCdWhereClause(filters);

    const [countRows, pagedAccounts, allAccounts] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total ${CD_FROM_SQL} ${whereClause}`, params),
      fetchCdAccounts({ whereClause, params, offset, limit: perPage }),
      fetchCdAccounts({ whereClause, params }),
    ]);

    const total = Number(countRows[0][0].total || 0);
    const packageBreakdown = buildCdPackageBreakdown(allAccounts);

    const stats = allAccounts.reduce((acc, account) => {
      acc.total += 1;
      if (account.isCdStatusPaid) acc.fullyPaid += 1;
      else acc.stillPaying += 1;
      acc.totalCdAmount += account.cdamount;
      acc.totalRemaining += account.remaining;
      acc.totalPaid += account.cdtotal;
      acc.totalDeductionCount += account.deductionCount;
      acc.totalEncashmentCount += account.encashmentCount;
      acc.totalNetEncashment += account.netEncashment;
      acc.totalCdDeduction += account.totalCdDeduction;
      return acc;
    }, {
      total: 0,
      fullyPaid: 0,
      stillPaying: 0,
      totalCdAmount: 0,
      totalRemaining: 0,
      totalPaid: 0,
      totalDeductionCount: 0,
      totalEncashmentCount: 0,
      totalNetEncashment: 0,
      totalCdDeduction: 0,
    });

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    res.json({
      success: true,
      accounts: pagedAccounts,
      stats,
      packageBreakdown,
      page,
      perPage,
      total,
      totalPages,
      filters: {
        search,
        status,
        packageType,
      },
      data: {
        accounts: pagedAccounts,
        summary: stats,
        packageBreakdown,
        pagination: {
          page,
          perPage,
          total,
          totalPages,
        },
      },
    });
  } catch (error) {
    console.error('[Admin CD Accounts] List error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
