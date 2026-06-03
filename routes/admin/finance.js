const express = require('express');
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
  buildSectionedCsv,
  sendCsv,
} = require('../../services/csvExport');

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
    const snapshot = await getFinanceSnapshot(year);
    const csv = buildSectionedCsv([
      {
        title: 'Finance Summary',
        rows: [
          { Metric: 'Year', Value: snapshot.year },
          { Metric: 'Gross Sales', Value: snapshot.totals.grossSales },
          { Metric: 'Expense Reserve Wallet', Value: snapshot.wallets.expenseReserveWallet },
          { Metric: 'Projected Operating Margin', Value: snapshot.totals.projectedOperatingMargin },
          { Metric: 'Encashment Requested', Value: snapshot.wallets.encashmentWallet.requestedAmount },
          { Metric: 'Net Encashment Payout', Value: snapshot.wallets.encashmentWallet.netPayout },
          { Metric: 'Service + Maintenance Wallet', Value: snapshot.wallets.serviceAndMaintenanceWallet.total },
          { Metric: 'CD Recovery Wallet', Value: snapshot.wallets.cdRecoveryWallet.totalCdDeduction },
        ],
      },
      {
        title: 'Package Accounting',
        rows: snapshot.packageRows.map((row) => ({
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
        })),
      },
      {
        title: 'Wallet Buckets',
        rows: [
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
        ],
      },
    ]);
    sendCsv(res, `finance-report-${year}`, csv);
  } catch (error) {
    console.error('[Admin Finance] Export error:', error);
    res.status(500).json({ error: error.message || 'Failed to export finance report' });
  }
});

module.exports = router;
