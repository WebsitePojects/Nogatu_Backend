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

  await conn.query(
    `CREATE TABLE IF NOT EXISTS finance_budget_columntab (
      id INT NOT NULL AUTO_INCREMENT,
      column_key VARCHAR(80) NOT NULL,
      label VARCHAR(120) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      active TINYINT NOT NULL DEFAULT 1,
      updated_by VARCHAR(120) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_finance_budget_column_key (column_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  await conn.query(
    `CREATE TABLE IF NOT EXISTS finance_budget_column_valuestab (
      column_id INT NOT NULL,
      package_type INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      updated_by VARCHAR(120) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (column_id, package_type),
      CONSTRAINT fk_finance_budget_value_column
        FOREIGN KEY (column_id) REFERENCES finance_budget_columntab (id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function listCustomBudgetColumns(conn = pool) {
  await ensureFinanceTables(conn);
  const [columns] = await conn.query(
    `SELECT id, column_key, label, sort_order, active, updated_by, updated_at
     FROM finance_budget_columntab
     WHERE active = 1
     ORDER BY sort_order ASC, id ASC`
  );
  const [values] = await conn.query(
    `SELECT column_id, package_type, amount
     FROM finance_budget_column_valuestab`
  );

  const valueMap = new Map();
  for (const row of values) {
    valueMap.set(`${Number(row.column_id)}:${Number(row.package_type)}`, toMoney(row.amount));
  }

  return columns.map((column) => ({
    id: Number(column.id),
    columnKey: column.column_key,
    label: column.label,
    sortOrder: Number(column.sort_order || 0),
    updatedBy: column.updated_by || null,
    updatedAt: column.updated_at || null,
    valuesByPackage: listPackagePolicies().reduce((acc, policy) => {
      acc[policy.packageType] = valueMap.get(`${Number(column.id)}:${Number(policy.packageType)}`) || 0;
      return acc;
    }, {}),
  }));
}

async function createCustomBudgetColumn(payload = {}, updatedBy = 'admin', conn = pool) {
  await ensureFinanceTables(conn);
  const label = String(payload.label || '').trim();
  if (!label) throw new Error('Column label is required.');

  const slugBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finance-column';
  let columnKey = slugBase;
  let attempt = 1;

  while (attempt <= 25) {
    const [rows] = await conn.query('SELECT id FROM finance_budget_columntab WHERE column_key = ? LIMIT 1', [columnKey]);
    if (rows.length === 0) break;
    attempt += 1;
    columnKey = `${slugBase}-${attempt}`;
  }

  const [existingRows] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM finance_budget_columntab');
  const sortOrder = Number(payload.sortOrder || existingRows[0]?.maxSort || 0) + 1;
  const [result] = await conn.query(
    `INSERT INTO finance_budget_columntab (column_key, label, sort_order, updated_by)
     VALUES (?, ?, ?, ?)`,
    [columnKey, label, sortOrder, String(updatedBy || 'admin')]
  );

  for (const policy of listPackagePolicies()) {
    const amount = toMoney(payload.valuesByPackage?.[policy.packageType]);
    await conn.query(
      `INSERT INTO finance_budget_column_valuestab (column_id, package_type, amount, updated_by)
       VALUES (?, ?, ?, ?)`,
      [result.insertId, Number(policy.packageType), amount, String(updatedBy || 'admin')]
    );
  }

  const columns = await listCustomBudgetColumns(conn);
  return columns.find((column) => column.id === Number(result.insertId)) || null;
}

async function updateCustomBudgetColumn(columnId, payload = {}, updatedBy = 'admin', conn = pool) {
  await ensureFinanceTables(conn);
  const id = Number(columnId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid finance column.');

  const label = String(payload.label || '').trim();
  if (!label) throw new Error('Column label is required.');

  await conn.query(
    `UPDATE finance_budget_columntab
     SET label = ?, sort_order = ?, updated_by = ?
     WHERE id = ?
     LIMIT 1`,
    [label, Number(payload.sortOrder || 0), String(updatedBy || 'admin'), id]
  );

  const columns = await listCustomBudgetColumns(conn);
  return columns.find((column) => column.id === id) || null;
}

async function saveCustomBudgetColumnValue(columnId, packageType, amount, updatedBy = 'admin', conn = pool) {
  await ensureFinanceTables(conn);
  const id = Number(columnId);
  const normalizedPackageType = Number(packageType);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid finance column.');
  if (!getPackagePolicy(normalizedPackageType).packageAmount) throw new Error('Invalid package type.');

  await conn.query(
    `INSERT INTO finance_budget_column_valuestab (column_id, package_type, amount, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), updated_by = VALUES(updated_by)`,
    [id, normalizedPackageType, toMoney(amount), String(updatedBy || 'admin')]
  );

  const columns = await listCustomBudgetColumns(conn);
  return columns.find((column) => column.id === id) || null;
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
  const [configs, salesMap, encashmentWallet, customColumns] = await Promise.all([
    listPackageConfigs(conn),
    loadPackageSalesByYear(year, conn),
    loadEncashmentWalletByYear(year, conn),
    listCustomBudgetColumns(conn),
  ]);

  const packageRows = configs.map((config) => {
    const salesRow = salesMap.get(Number(config.packageType)) || {};
    const soldCount = Number(salesRow.soldCount || 0);
    const grossSales = toMoney(salesRow.grossSales || (soldCount * config.packageAmount));
    const customBudgetColumns = customColumns.map((column) => {
      const amount = toMoney(column.valuesByPackage?.[config.packageType] || 0);
      return {
        id: column.id,
        columnKey: column.columnKey,
        label: column.label,
        amount,
        total: toMoney(amount * soldCount),
      };
    });
    const customReservePerCode = toMoney(customBudgetColumns.reduce((sum, column) => sum + column.amount, 0));
    const customReserveTotal = toMoney(customBudgetColumns.reduce((sum, column) => sum + column.total, 0));
    const reservePerCode = toMoney(config.reservePerCode + customReservePerCode);
    const reserveTotal = toMoney(reservePerCode * soldCount);
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
      reservePerCode,
      reserveTotal,
      customBudgetColumns,
      customReservePerCode,
      customReserveTotal,
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
    acc.customReserveTotal += row.customReserveTotal;
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
    customReserveTotal: 0,
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
      customReserveTotal: toMoney(totals.customReserveTotal),
      expenseReserveWallet: toMoney(totals.expenseReserveWallet),
      projectedOperatingMargin: toMoney(totals.projectedOperatingMargin),
    },
    customColumns,
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
  listCustomBudgetColumns,
  createCustomBudgetColumn,
  updateCustomBudgetColumn,
  saveCustomBudgetColumnValue,
  getFinanceSnapshot,
};
