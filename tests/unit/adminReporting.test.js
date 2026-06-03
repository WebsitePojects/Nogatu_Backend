const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEncashmentSummary,
  buildEncashmentExportRows,
  buildCdPackageBreakdown,
  buildCdExportRows,
} = require('../../services/adminReporting');

test('buildEncashmentSummary groups encashments by day and totals deductions cleanly', () => {
  const summary = buildEncashmentSummary([
    {
      cashtransdate: '2026-05-15',
      encashment: 1000,
      tax: 100,
      fee: 50,
      cdDeduction: 25,
      cashStatus: 1,
      uid: 1,
    },
    {
      cashtransdate: '2026-05-15',
      encashment: 500,
      tax: 50,
      fee: 20,
      cdDeduction: 0,
      cashStatus: 0,
      uid: 2,
    },
    {
      cashtransdate: '2026-05-14',
      encashment: 750,
      tax: 75,
      fee: 30,
      cdDeduction: 15,
      cashStatus: 1,
      uid: 2,
    },
  ]);

  assert.deepEqual(summary.overview, {
    totalRecords: 3,
    uniqueMembers: 2,
    grossEncashment: 2615,
    netReceivable: 2250,
    totalTax: 225,
    totalFee: 100,
    totalCdDeduction: 40,
    totalDeductions: 365,
    paidCount: 2,
    pendingCount: 1,
  });

  assert.deepEqual(summary.daily, [
    {
      date: '2026-05-15',
      totalRecords: 2,
      uniqueMembers: 2,
      grossEncashment: 1745,
      netReceivable: 1500,
      totalTax: 150,
      totalFee: 70,
      totalCdDeduction: 25,
      totalDeductions: 245,
      paidCount: 1,
      pendingCount: 1,
    },
    {
      date: '2026-05-14',
      totalRecords: 1,
      uniqueMembers: 1,
      grossEncashment: 870,
      netReceivable: 750,
      totalTax: 75,
      totalFee: 30,
      totalCdDeduction: 15,
      totalDeductions: 120,
      paidCount: 1,
      pendingCount: 0,
    },
  ]);
});

test('buildEncashmentExportRows includes both gross and net-ready financial columns', () => {
  const rows = buildEncashmentExportRows([
    {
      cashtransdate: '2026-05-15',
      fullname: 'Vergel Bautista',
      username: 'ver',
      payoutOption: 'GCash',
      payoutDetails: 'GCash / 09171234567',
      encashment: 1000,
      tax: 100,
      fee: 50,
      cdDeduction: 25,
      deductions: 175,
      cashStatusLabel: 'Paid',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    'Date': '2026-05-15',
    'Full Name': 'Vergel Bautista',
    'Username': 'ver',
    'Gross Encashment': 1175,
    'Net Receivable': 1000,
    'Tax': 100,
    'Fee': 50,
    'CD Deduction': 25,
    'Total Deductions': 175,
    'Payout Option': 'GCash',
    'Payout Details': 'GCash / 09171234567',
    'Status': 'Paid',
  });
});

test('buildCdPackageBreakdown summarizes paid vs paying accounts per package', () => {
  const breakdown = buildCdPackageBreakdown([
    { package: 'Platinum', cdamount: 25000, cdtotal: 25000, remaining: 0, deductionCount: 4, encashmentCount: 4, netEncashment: 100000, isRecoveredFullyPaid: true },
    { package: 'Platinum', cdamount: 25000, cdtotal: 10000, remaining: 15000, deductionCount: 2, encashmentCount: 2, netEncashment: 40000, isRecoveredFullyPaid: false },
    { package: 'Gold', cdamount: 10000, cdtotal: 0, remaining: 10000, deductionCount: 0, encashmentCount: 0, netEncashment: 0, isRecoveredFullyPaid: false },
  ]);

  assert.deepEqual(breakdown, [
    {
      package: 'Platinum',
      totalAccounts: 2,
      fullyPaid: 1,
      stillPaying: 1,
      totalCdAmount: 50000,
      totalPaid: 35000,
      totalRemaining: 15000,
      totalDeductionCount: 6,
      totalEncashmentCount: 6,
      totalNetEncashment: 140000,
    },
    {
      package: 'Gold',
      totalAccounts: 1,
      fullyPaid: 0,
      stillPaying: 1,
      totalCdAmount: 10000,
      totalPaid: 0,
      totalRemaining: 10000,
      totalDeductionCount: 0,
      totalEncashmentCount: 0,
      totalNetEncashment: 0,
    },
  ]);
});

test('buildCdExportRows flattens CD account drilldown metrics for admin exports', () => {
  const rows = buildCdExportRows([
    {
      username: 'ver',
      fullname: 'Vergel Bautista',
      package: 'Platinum',
      cdstatusLabel: 'Fully Paid',
      cdamount: 25000,
      cdtotal: 25000,
      remaining: 0,
      recoveredRemaining: 0,
      progress: 100,
      deductionCount: 4,
      encashmentCount: 4,
      netEncashment: 100000,
      firstDeductionDate: '2026-01-01',
      lastDeductionDate: '2026-04-01',
      datereg: '2025-12-01',
    },
  ]);

  assert.deepEqual(rows, [
    {
      'Username': 'ver',
      'Full Name': 'Vergel Bautista',
      'Package': 'Platinum',
      'CD Status': 'Fully Paid',
      'CD Amount': 25000,
      'CD Paid': 25000,
      'CD Remaining': 0,
      'Recovered Remaining': 0,
      'Progress %': 100,
      'CD Deduction Count': 4,
      'Encashment Count': 4,
      'Net Encashment Recovered': 100000,
      'First CD Deduction': '2026-01-01',
      'Last CD Deduction': '2026-04-01',
      'Date Registered': '2025-12-01',
    },
  ]);
});
