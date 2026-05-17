const { pool } = require('../config/database');
const {
  listPackagePolicies,
  getPackagePolicy,
  getPackageDefaultSalesMatchReserveCeiling,
} = require('./packagePolicy');

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function toMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function normalizeFinanceYear(year, now = new Date()) {
  return Math.max(2000, Number(year) || Number(now.getFullYear()));
}

async function ensureFinanceTables(conn = pool) {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS finance_package_coststab (
      package_type INT NOT NULL,
      product_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
      sales_match_ceiling DECIMAL(12,2) NOT NULL DEFAULT 0,
      admin_extra_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
      notes VARCHAR(255) DEFAULT NULL,
      updated_by VARCHAR(120) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (package_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  for (const policy of listPackagePolicies()) {
    await conn.query(
      `INSERT INTO finance_package_coststab
        (package_type, product_cost, sales_match_ceiling, admin_extra_cost, notes, updated_by)
       VALUES (?, 0, ?, 0, NULL, 'system-seed')
       ON DUPLICATE KEY UPDATE
         sales_match_ceiling = IF(sales_match_ceiling = 0, VALUES(sales_match_ceiling), sales_match_ceiling)`,
      [policy.packageType, Number(getPackageDefaultSalesMatchReserveCeiling(policy.packageType) || 0)]
    );
  }
}

async function listPackageConfigs(conn = pool) {
  await ensureFinanceTables(conn);
  const [rows] = await conn.query(
    `SELECT package_type, product_cost, sales_match_ceiling, admin_extra_cost, notes, updated_by, updated_at
     FROM finance_package_coststab
     ORDER BY package_type ASC`
  );

  const configMap = new Map(rows.map((row) => [Number(row.package_type), row]));
  return listPackagePolicies().map((policy) => {
    const row = configMap.get(Number(policy.packageType)) || {};
    const directReferralFixed = toMoney(policy.directReferralBonus || (policy.packageAmount * 0.10));
    const productCost = toMoney(row.product_cost);
    const salesMatchCeiling = toMoney(row.sales_match_ceiling || getPackageDefaultSalesMatchReserveCeiling(policy.packageType));
    const adminExtraCost = toMoney(row.admin_extra_cost);
    const reservePerCode = toMoney(productCost + salesMatchCeiling + directReferralFixed + adminExtraCost);
    return {
      packageType: Number(policy.packageType),
      packageLabel: policy.packageLabel,
      packageAmount: toMoney(policy.packageAmount),
      directReferralFixed,
      productCost,
      salesMatchCeiling,
      adminExtraCost,
      reservePerCode,
      notes: row.notes || '',
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at || null,
      policy,
    };
  });
}

async function savePackageConfig(packageType, payload = {}, updatedBy = 'admin', conn = pool) {
  const policy = getPackagePolicy(packageType);
  if (!policy.packageAmount) {
    throw new Error('Invalid package type.');
  }

  await ensureFinanceTables(conn);
  await conn.query(
    `INSERT INTO finance_package_coststab
      (package_type, product_cost, sales_match_ceiling, admin_extra_cost, notes, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       product_cost = VALUES(product_cost),
       sales_match_ceiling = VALUES(sales_match_ceiling),
       admin_extra_cost = VALUES(admin_extra_cost),
       notes = VALUES(notes),
       updated_by = VALUES(updated_by)`,
    [
      Number(policy.packageType),
      toMoney(payload.productCost),
      toMoney(payload.salesMatchCeiling || getPackageDefaultSalesMatchReserveCeiling(policy.packageType)),
      toMoney(payload.adminExtraCost),
      String(payload.notes || '').trim() || null,
      String(updatedBy || 'admin'),
    ]
  );

  const configs = await listPackageConfigs(conn);
  return configs.find((item) => Number(item.packageType) === Number(policy.packageType)) || null;
}

async function loadPackageSalesByYear(year, conn = pool) {
  const [rows] = await conn.query(
    `SELECT producttype AS packageType,
            COUNT(*) AS soldCount,
            COALESCE(SUM(productamount), 0) AS grossSales
     FROM codestab
     WHERE codestatus = 2
       AND producttype IN (10, 20, 30, 40, 50, 60)
       AND YEAR(dateused) = ?
     GROUP BY producttype
     ORDER BY producttype ASC`,
    [year]
  );
  return new Map(rows.map((row) => [Number(row.packageType), row]));
}

async function loadEncashmentWalletByYear(year, conn = pool) {
  const [rows] = await conn.query(
    `SELECT
        COUNT(*) AS totalRequests,
        COALESCE(SUM(requested_amount), 0) AS requestedAmount,
        COALESCE(SUM(net_payout), 0) AS netPayout,
        COALESCE(SUM(tax_amount), 0) AS taxAmount,
        COALESCE(SUM(processing_fee), 0) AS processingFee,
        COALESCE(SUM(maintenance_fee), 0) AS maintenanceFee,
        COALESCE(SUM(cd_deduction), 0) AS cdDeduction,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN net_payout ELSE 0 END), 0) AS paidOut,
        COALESCE(SUM(CASE WHEN status IN ('submitted', 'approved', 'processing') THEN net_payout ELSE 0 END), 0) AS pendingPayout
     FROM encashmentstab
     WHERE YEAR(created_at) = ?`,
    [year]
  ).catch(async (error) => {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    return [[{
      totalRequests: 0,
      requestedAmount: 0,
      netPayout: 0,
      taxAmount: 0,
      processingFee: 0,
      maintenanceFee: 0,
      cdDeduction: 0,
      paidOut: 0,
      pendingPayout: 0,
    }]];
  });

  const row = rows[0] || {};
  const serviceFeeWallet = toMoney(toNumber(row.taxAmount) + toNumber(row.processingFee) + toNumber(row.maintenanceFee));
  return {
    totalRequests: Number(row.totalRequests || 0),
    requestedAmount: toMoney(row.requestedAmount),
    netPayout: toMoney(row.netPayout),
    taxAmount: toMoney(row.taxAmount),
    processingFee: toMoney(row.processingFee),
    maintenanceFee: toMoney(row.maintenanceFee),
    cdDeduction: toMoney(row.cdDeduction),
    paidOut: toMoney(row.paidOut),
    pendingPayout: toMoney(row.pendingPayout),
    serviceFeeWallet,
  };
}

async function getFinanceSnapshot(yearInput, conn = pool) {
  const year = normalizeFinanceYear(yearInput);
  const [configs, salesMap, encashmentWallet] = await Promise.all([
    listPackageConfigs(conn),
    loadPackageSalesByYear(year, conn),
    loadEncashmentWalletByYear(year, conn),
  ]);

  const packageRows = configs.map((config) => {
    const salesRow = salesMap.get(Number(config.packageType)) || {};
    const soldCount = Number(salesRow.soldCount || 0);
    const grossSales = toMoney(salesRow.grossSales || (soldCount * config.packageAmount));
    const reserveTotal = toMoney(config.reservePerCode * soldCount);
    const productCostTotal = toMoney(config.productCost * soldCount);
    const directReferralTotal = toMoney(config.directReferralFixed * soldCount);
    const salesMatchReserveTotal = toMoney(config.salesMatchCeiling * soldCount);
    const adminExtraTotal = toMoney(config.adminExtraCost * soldCount);
    const projectedOperatingMargin = toMoney(grossSales - reserveTotal);

    return {
      packageType: config.packageType,
      packageLabel: config.packageLabel,
      soldCount,
      packageAmount: config.packageAmount,
      grossSales,
      productCost: config.productCost,
      productCostTotal,
      salesMatchCeiling: config.salesMatchCeiling,
      salesMatchReserveTotal,
      directReferralFixed: config.directReferralFixed,
      directReferralTotal,
      adminExtraCost: config.adminExtraCost,
      adminExtraTotal,
      reservePerCode: config.reservePerCode,
      reserveTotal,
      projectedOperatingMargin,
      notes: config.notes,
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    };
  });

  const totals = packageRows.reduce((acc, row) => {
    acc.totalPackagesSold += row.soldCount;
    acc.grossSales += row.grossSales;
    acc.productCostTotal += row.productCostTotal;
    acc.salesMatchReserveTotal += row.salesMatchReserveTotal;
    acc.directReferralTotal += row.directReferralTotal;
    acc.adminExtraTotal += row.adminExtraTotal;
    acc.expenseReserveWallet += row.reserveTotal;
    acc.projectedOperatingMargin += row.projectedOperatingMargin;
    return acc;
  }, {
    totalPackagesSold: 0,
    grossSales: 0,
    productCostTotal: 0,
    salesMatchReserveTotal: 0,
    directReferralTotal: 0,
    adminExtraTotal: 0,
    expenseReserveWallet: 0,
    projectedOperatingMargin: 0,
  });

  return {
    year,
    packageRows,
    packageConfigs: configs.map((config) => ({
      packageType: config.packageType,
      packageLabel: config.packageLabel,
      packageAmount: config.packageAmount,
      directReferralFixed: config.directReferralFixed,
      productCost: config.productCost,
      salesMatchCeiling: config.salesMatchCeiling,
      adminExtraCost: config.adminExtraCost,
      reservePerCode: config.reservePerCode,
      notes: config.notes,
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    })),
    totals: {
      totalPackagesSold: totals.totalPackagesSold,
      grossSales: toMoney(totals.grossSales),
      productCostTotal: toMoney(totals.productCostTotal),
      salesMatchReserveTotal: toMoney(totals.salesMatchReserveTotal),
      directReferralTotal: toMoney(totals.directReferralTotal),
      adminExtraTotal: toMoney(totals.adminExtraTotal),
      expenseReserveWallet: toMoney(totals.expenseReserveWallet),
      projectedOperatingMargin: toMoney(totals.projectedOperatingMargin),
    },
    wallets: {
      expenseReserveWallet: toMoney(totals.expenseReserveWallet),
      encashmentWallet: {
        requestedAmount: encashmentWallet.requestedAmount,
        netPayout: encashmentWallet.netPayout,
        paidOut: encashmentWallet.paidOut,
        pendingPayout: encashmentWallet.pendingPayout,
        totalRequests: encashmentWallet.totalRequests,
      },
      serviceAndMaintenanceWallet: {
        taxAmount: encashmentWallet.taxAmount,
        processingFee: encashmentWallet.processingFee,
        maintenanceFee: encashmentWallet.maintenanceFee,
        total: encashmentWallet.serviceFeeWallet,
      },
      cdRecoveryWallet: {
        totalCdDeduction: encashmentWallet.cdDeduction,
      },
    },
  };
}

module.exports = {
  normalizeFinanceYear,
  ensureFinanceTables,
  listPackageConfigs,
  savePackageConfig,
  getFinanceSnapshot,
};
