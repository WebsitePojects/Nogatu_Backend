const express = require('express');
const XLSX = require('xlsx');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  getFinanceSnapshot,
  savePackageConfig,
  createCustomBudgetColumn,
  updateCustomBudgetColumn,
  saveCustomBudgetColumnValue,
  normalizeFinanceYear,
} = require('../../services/adminFinance');
const {
  renderAdminPdfReport,
  sendPdfReport,
} = require('../../services/jsreportExport');

function addSheet(workbook, name, rows, widths = []) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  if (widths.length) {
    sheet['!cols'] = widths.map((wch) => ({ wch }));
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function buildFinanceWorkbook(snapshot) {
  const workbook = XLSX.utils.book_new();
  addSheet(workbook, 'Finance Summary', [
    { Metric: 'Year', Value: snapshot.year },
    { Metric: 'Gross Sales', Value: snapshot.totals.grossSales },
    { Metric: 'Expense Reserve Wallet', Value: snapshot.wallets.expenseReserveWallet },
    { Metric: 'Projected Operating Margin', Value: snapshot.totals.projectedOperatingMargin },
    { Metric: 'Encashment Requested', Value: snapshot.wallets.encashmentWallet.requestedAmount },
    { Metric: 'Net Encashment Payout', Value: snapshot.wallets.encashmentWallet.netPayout },
    { Metric: 'Service + Maintenance Wallet', Value: snapshot.wallets.serviceAndMaintenanceWallet.total },
    { Metric: 'CD Recovery Wallet', Value: snapshot.wallets.cdRecoveryWallet.totalCdDeduction },
  ], [28, 18]);

  addSheet(workbook, 'Package Accounting', snapshot.packageRows.map((row) => ({
    Package: row.packageLabel,
    'Codes Used': row.soldCount,
    'Package Amount': row.packageAmount,
    'Gross Sales': row.grossSales,
    'Product Cost Per Code': row.productCost,
    'Product Cost Total': row.productCostTotal,
    'Sales Match Ceiling Per Code': row.salesMatchCeiling,
    'Sales Match Reserve Total': row.salesMatchReserveTotal,
    'Direct Referral Per Code': row.directReferralFixed,
    'Direct Referral Total': row.directReferralTotal,
    'Admin Or Ops Reserve Per Code': row.adminExtraCost,
    'Admin Or Ops Reserve Total': row.adminExtraTotal,
    'Reserve Per Code': row.reservePerCode,
    'Reserve Total': row.reserveTotal,
    'Projected Margin': row.projectedOperatingMargin,
    Notes: row.notes || '',
  })), [14, 12, 16, 16, 20, 18, 26, 22, 22, 18, 20, 18, 18, 18, 18, 24]);

  addSheet(workbook, 'Wallet Buckets', [
    {
      'Wallet Bucket': 'Expense Reserve',
      Gross: snapshot.wallets.expenseReserveWallet,
      Notes: 'Package-linked reserve for product cost, sales-match ceiling, direct referral, and admin or ops reserve costs.',
    },
    {
      'Wallet Bucket': 'Encashment',
      Gross: snapshot.wallets.encashmentWallet.requestedAmount,
      Notes: `Paid out ${snapshot.wallets.encashmentWallet.paidOut} / Pending ${snapshot.wallets.encashmentWallet.pendingPayout}`,
    },
    {
      'Wallet Bucket': 'Service + Maintenance',
      Gross: snapshot.wallets.serviceAndMaintenanceWallet.total,
      Notes: `Tax ${snapshot.wallets.serviceAndMaintenanceWallet.taxAmount}, Fee ${snapshot.wallets.serviceAndMaintenanceWallet.processingFee}, Maintenance ${snapshot.wallets.serviceAndMaintenanceWallet.maintenanceFee}`,
    },
    {
      'Wallet Bucket': 'CD Recovery',
      Gross: snapshot.wallets.cdRecoveryWallet.totalCdDeduction,
      Notes: 'Recovered CD deductions from encashment flows.',
    },
  ], [24, 18, 90]);

  return workbook;
}

function money(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildFinancePdfDefinition(snapshot) {
  const packageScale = Math.max(1, ...snapshot.packageRows.map((row) => Number(row.grossSales || 0)));
  const walletRows = [
    { label: 'Expense Reserve', value: Number(snapshot.wallets.expenseReserveWallet || 0), color: '#d97706' },
    { label: 'Encashment Requested', value: Number(snapshot.wallets.encashmentWallet.requestedAmount || 0), color: '#1d4ed8' },
    { label: 'Service + Maintenance', value: Number(snapshot.wallets.serviceAndMaintenanceWallet.total || 0), color: '#0f766e' },
    { label: 'CD Recovery', value: Number(snapshot.wallets.cdRecoveryWallet.totalCdDeduction || 0), color: '#b45309' },
  ];
  const walletScale = Math.max(1, ...walletRows.map((row) => row.value));

  return {
    fileName: `finance-report-${snapshot.year}`,
    title: `Finance Accounting ${snapshot.year}`,
    subtitle: 'Annual reserve planning, package sales, encashment obligations, and service-fee capture.',
    generatedAt: new Date().toLocaleString('en-PH', { hour12: true }),
    filterChips: [`Year: ${snapshot.year}`],
    summaryCards: [
      { label: 'Codes Used', value: String(snapshot.totals.totalPackagesSold || 0), color: '#b45309' },
      { label: 'Gross Sales', value: money(snapshot.totals.grossSales), color: '#a16207' },
      { label: 'Expense Reserve', value: money(snapshot.totals.expenseReserveWallet), color: '#d97706' },
      { label: 'Projected Margin', value: money(snapshot.totals.projectedOperatingMargin), color: '#047857' },
      { label: 'Encashment Requested', value: money(snapshot.wallets.encashmentWallet.requestedAmount), color: '#1d4ed8' },
      { label: 'Service + Maintenance', value: money(snapshot.wallets.serviceAndMaintenanceWallet.total), color: '#0f766e' },
      { label: 'CD Recovery', value: money(snapshot.wallets.cdRecoveryWallet.totalCdDeduction), color: '#b45309' },
      { label: 'Admin / Ops Reserve', value: money(snapshot.totals.adminExtraTotal), color: '#7c3aed' },
    ],
    charts: [
      {
        title: 'Package Sales Ladder',
        note: 'Gross sales by package for the selected year. This makes the biggest package contributors immediately visible for accounting review.',
        bars: snapshot.packageRows.map((row) => ({
          label: row.packageLabel,
          valueLabel: money(row.grossSales),
          percent: Math.max(4, Math.round((Number(row.grossSales || 0) / packageScale) * 100)),
          color: '#d4af37',
        })),
      },
      {
        title: 'Reserve Wallet Mix',
        note: 'Wallet buckets available from the current accounting records and reserve computations.',
        bars: walletRows.map((row) => ({
          label: row.label,
          valueLabel: money(row.value),
          percent: Math.max(4, Math.round((row.value / walletScale) * 100)),
          color: row.color,
        })),
      },
    ],
    tables: [
      {
        title: 'Package Accounting',
        note: 'Direct referral stays fixed at 10% of package amount. Admin / Ops Reserve is the manual reserve bucket set per code.',
        columns: [
          'Package',
          'Codes Used',
          'Gross Sales',
          'Product Cost Total',
          'SMB Reserve Total',
          'Direct Referral Total',
          'Admin / Ops Total',
          'Reserve Total',
          'Projected Margin',
        ],
        rows: snapshot.packageRows.map((row) => ([
          row.packageLabel,
          String(row.soldCount || 0),
          money(row.grossSales),
          money(row.productCostTotal),
          money(row.salesMatchReserveTotal),
          money(row.directReferralTotal),
          money(row.adminExtraTotal),
          money(row.reserveTotal),
          money(row.projectedOperatingMargin),
        ])),
      },
      {
        title: 'Wallet Buckets',
        columns: ['Bucket', 'Amount', 'Notes'],
        rows: [
          ['Expense Reserve', money(snapshot.wallets.expenseReserveWallet), 'Package-linked reserve for product cost, SMB reserve, direct referral, and admin or ops reserve.'],
          ['Encashment Requested', money(snapshot.wallets.encashmentWallet.requestedAmount), `Paid out ${money(snapshot.wallets.encashmentWallet.paidOut)} / Pending ${money(snapshot.wallets.encashmentWallet.pendingPayout)}`],
          ['Service + Maintenance', money(snapshot.wallets.serviceAndMaintenanceWallet.total), `Tax ${money(snapshot.wallets.serviceAndMaintenanceWallet.taxAmount)} / Fee ${money(snapshot.wallets.serviceAndMaintenanceWallet.processingFee)} / Maintenance ${money(snapshot.wallets.serviceAndMaintenanceWallet.maintenanceFee)}`],
          ['CD Recovery', money(snapshot.wallets.cdRecoveryWallet.totalCdDeduction), 'Recovered CD deductions from encashment flows.'],
        ],
      },
    ],
  };
}

router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = normalizeFinanceYear(req.query.year);
    const snapshot = await getFinanceSnapshot(year);
    res.json(snapshot);
  } catch (error) {
    console.error('[Admin Finance] Snapshot error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.put('/package-config/:packageType', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const packageType = Number(req.params.packageType);
    const updatedBy = req.session.adminname || req.session.adminid || 'admin';
    const config = await savePackageConfig(packageType, req.body || {}, updatedBy);
    res.json({ success: true, config });
  } catch (error) {
    console.error('[Admin Finance] Config save error:', error);
    res.status(400).json({ error: error.message || 'Failed to save package finance config' });
  }
});

router.post('/custom-columns', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const updatedBy = req.session.adminname || req.session.adminid || 'admin';
    const column = await createCustomBudgetColumn(req.body || {}, updatedBy);
    res.json({ success: true, column });
  } catch (error) {
    console.error('[Admin Finance] Custom column create error:', error);
    res.status(400).json({ error: error.message || 'Failed to create finance column' });
  }
});

router.put('/custom-columns/:columnId', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const updatedBy = req.session.adminname || req.session.adminid || 'admin';
    const column = await updateCustomBudgetColumn(req.params.columnId, req.body || {}, updatedBy);
    res.json({ success: true, column });
  } catch (error) {
    console.error('[Admin Finance] Custom column update error:', error);
    res.status(400).json({ error: error.message || 'Failed to update finance column' });
  }
});

router.put('/custom-columns/:columnId/values/:packageType', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const updatedBy = req.session.adminname || req.session.adminid || 'admin';
    const column = await saveCustomBudgetColumnValue(req.params.columnId, req.params.packageType, req.body?.amount, updatedBy);
    res.json({ success: true, column });
  } catch (error) {
    console.error('[Admin Finance] Custom column value update error:', error);
    res.status(400).json({ error: error.message || 'Failed to update finance column value' });
  }
});

router.get('/export', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const year = normalizeFinanceYear(req.query.year);
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const snapshot = await getFinanceSnapshot(year);

    if (format === 'pdf' || format === 'crystal') {
      const report = await renderAdminPdfReport(buildFinancePdfDefinition(snapshot));
      sendPdfReport(res, report);
      return;
    }

    const workbook = buildFinanceWorkbook(snapshot);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="finance-report-${year}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('[Admin Finance] Export error:', error);
    res.status(500).json({ error: error.message || 'Failed to export finance report' });
  }
});

module.exports = router;
