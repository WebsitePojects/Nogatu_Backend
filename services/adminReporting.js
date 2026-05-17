function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDate(value) {
  if (!value) return 'Unknown';
  return String(value).slice(0, 10);
}

function summarizeEncashmentRow(row) {
  const netReceivable = toNumber(row.encashment);
  const totalTax = toNumber(row.tax);
  const totalFee = toNumber(row.fee);
  const totalCdDeduction = toNumber(row.cdDeduction);
  const totalDeductions = totalTax + totalFee + totalCdDeduction;
  return {
    date: normalizeDate(row.cashtransdate),
    uid: row.uid == null ? null : Number(row.uid),
    netReceivable,
    totalTax,
    totalFee,
    totalCdDeduction,
    totalDeductions,
    grossEncashment: netReceivable + totalDeductions,
    isPaid: Number(row.cashStatus || 0) === 1,
  };
}

function finalizeEncashmentAggregate(target) {
  return {
    date: target.date,
    totalRecords: target.totalRecords,
    uniqueMembers: target.memberIds.size,
    grossEncashment: target.grossEncashment,
    netReceivable: target.netReceivable,
    totalTax: target.totalTax,
    totalFee: target.totalFee,
    totalCdDeduction: target.totalCdDeduction,
    totalDeductions: target.totalDeductions,
    paidCount: target.paidCount,
    pendingCount: target.pendingCount,
  };
}

function buildEncashmentSummary(records = []) {
  const overview = {
    date: null,
    totalRecords: 0,
    memberIds: new Set(),
    grossEncashment: 0,
    netReceivable: 0,
    totalTax: 0,
    totalFee: 0,
    totalCdDeduction: 0,
    totalDeductions: 0,
    paidCount: 0,
    pendingCount: 0,
  };

  const byDate = new Map();

  for (const row of records) {
    const summary = summarizeEncashmentRow(row);

    overview.totalRecords += 1;
    if (summary.uid != null) overview.memberIds.add(summary.uid);
    overview.grossEncashment += summary.grossEncashment;
    overview.netReceivable += summary.netReceivable;
    overview.totalTax += summary.totalTax;
    overview.totalFee += summary.totalFee;
    overview.totalCdDeduction += summary.totalCdDeduction;
    overview.totalDeductions += summary.totalDeductions;
    if (summary.isPaid) overview.paidCount += 1;
    else overview.pendingCount += 1;

    if (!byDate.has(summary.date)) {
      byDate.set(summary.date, {
        date: summary.date,
        totalRecords: 0,
        memberIds: new Set(),
        grossEncashment: 0,
        netReceivable: 0,
        totalTax: 0,
        totalFee: 0,
        totalCdDeduction: 0,
        totalDeductions: 0,
        paidCount: 0,
        pendingCount: 0,
      });
    }

    const bucket = byDate.get(summary.date);
    bucket.totalRecords += 1;
    if (summary.uid != null) bucket.memberIds.add(summary.uid);
    bucket.grossEncashment += summary.grossEncashment;
    bucket.netReceivable += summary.netReceivable;
    bucket.totalTax += summary.totalTax;
    bucket.totalFee += summary.totalFee;
    bucket.totalCdDeduction += summary.totalCdDeduction;
    bucket.totalDeductions += summary.totalDeductions;
    if (summary.isPaid) bucket.paidCount += 1;
    else bucket.pendingCount += 1;
  }

  return {
    overview: {
      totalRecords: overview.totalRecords,
      uniqueMembers: overview.memberIds.size,
      grossEncashment: overview.grossEncashment,
      netReceivable: overview.netReceivable,
      totalTax: overview.totalTax,
      totalFee: overview.totalFee,
      totalCdDeduction: overview.totalCdDeduction,
      totalDeductions: overview.totalDeductions,
      paidCount: overview.paidCount,
      pendingCount: overview.pendingCount,
    },
    daily: Array.from(byDate.values())
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map(finalizeEncashmentAggregate),
  };
}

function buildEncashmentExportRows(records = []) {
  return records.map((row) => {
    const netReceivable = toNumber(row.encashment);
    const tax = toNumber(row.tax);
    const fee = toNumber(row.fee);
    const cdDeduction = toNumber(row.cdDeduction);
    const totalDeductions = toNumber(row.deductions || tax + fee + cdDeduction);
    return {
      Date: normalizeDate(row.cashtransdate),
      'Full Name': row.fullname || '',
      Username: row.username || '',
      'Gross Encashment': netReceivable + totalDeductions,
      'Net Receivable': netReceivable,
      Tax: tax,
      Fee: fee,
      'CD Deduction': cdDeduction,
      'Total Deductions': totalDeductions,
      'Payout Option': row.payoutOption || '',
      'Payout Details': row.payoutDetails || '',
      Status: row.cashStatusLabel || '',
    };
  });
}

function buildCdPackageBreakdown(accounts = []) {
  const grouped = new Map();

  for (const account of accounts) {
    const key = account.package || 'Unknown';
    if (!grouped.has(key)) {
      grouped.set(key, {
        package: key,
        totalAccounts: 0,
        fullyPaid: 0,
        stillPaying: 0,
        totalCdAmount: 0,
        totalPaid: 0,
        totalRemaining: 0,
        totalDeductionCount: 0,
        totalEncashmentCount: 0,
        totalNetEncashment: 0,
      });
    }

    const bucket = grouped.get(key);
    const remaining = toNumber(account.remaining);
    const isFullyPaid = Boolean(account.isRecoveredFullyPaid);

    bucket.totalAccounts += 1;
    if (isFullyPaid) bucket.fullyPaid += 1;
    else bucket.stillPaying += 1;
    bucket.totalCdAmount += toNumber(account.cdamount);
    bucket.totalPaid += toNumber(account.cdtotal);
    bucket.totalRemaining += remaining;
    bucket.totalDeductionCount += toNumber(account.deductionCount);
    bucket.totalEncashmentCount += toNumber(account.encashmentCount);
    bucket.totalNetEncashment += toNumber(account.netEncashment);
  }

  return Array.from(grouped.values()).sort((a, b) => b.totalCdAmount - a.totalCdAmount);
}

function buildCdExportRows(accounts = []) {
  return accounts.map((account) => ({
    Username: account.username || '',
    'Full Name': account.fullname || '',
    Package: account.package || '',
    'CD Status': account.cdstatusLabel || '',
    'CD Amount': toNumber(account.cdamount),
    'CD Paid': toNumber(account.cdtotal),
    'CD Remaining': toNumber(account.remaining),
    'Recovered Remaining': toNumber(account.recoveredRemaining),
    'Progress %': toNumber(account.progress),
    'CD Deduction Count': toNumber(account.deductionCount),
    'Encashment Count': toNumber(account.encashmentCount),
    'Net Encashment Recovered': toNumber(account.netEncashment),
    'First CD Deduction': account.firstDeductionDate || '',
    'Last CD Deduction': account.lastDeductionDate || '',
    'Date Registered': account.datereg || '',
  }));
}

module.exports = {
  buildEncashmentSummary,
  buildEncashmentExportRows,
  buildCdPackageBreakdown,
  buildCdExportRows,
};
