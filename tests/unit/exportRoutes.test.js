const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

function createDownloadResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runHandlers(handlers, req, res) {
  let index = -1;

  async function dispatch(nextIndex) {
    index = nextIndex;
    const handler = handlers[nextIndex];
    if (!handler) return;
    const maybePromise = handler(req, res, (err) => {
      if (err) throw err;
      return dispatch(nextIndex + 1);
    });
    if (maybePromise && typeof maybePromise.then === 'function') {
      await maybePromise;
    }
  }

  await dispatch(0);
}

function withStubbedModules(stubs, loadModule) {
  const saved = new Map();

  for (const [absolutePath, exports] of Object.entries(stubs)) {
    saved.set(absolutePath, require.cache[absolutePath]);
    require.cache[absolutePath] = {
      id: absolutePath,
      filename: absolutePath,
      loaded: true,
      exports,
    };
  }

  try {
    return loadModule();
  } finally {
    for (const [absolutePath, cached] of saved.entries()) {
      if (cached) require.cache[absolutePath] = cached;
      else delete require.cache[absolutePath];
    }
  }
}

function getRouteHandlers(router, method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${routePath} should exist`);
  return layer.route.stack.map((entry) => entry.handle);
}

function loadFinanceRouter(snapshot) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'finance.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'services', 'adminFinance.js')]: {
      getFinanceSnapshot: async () => snapshot,
      savePackageConfig: async () => ({}),
      createCustomBudgetColumn: async () => ({}),
      updateCustomBudgetColumn: async () => ({}),
      saveCustomBudgetColumnValue: async () => ({}),
      normalizeFinanceYear: (year) => Number(year || 2026),
    },
  }, () => require(routePath));
}

function loadCodesRouter(historyResult) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'codes.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: async () => [[]] },
    },
    [path.join(repoRoot, 'services', 'codeGeneration.js')]: {
      generateCodes: async () => [],
    },
    [path.join(repoRoot, 'utils', 'helpers.js')]: {
      PRODUCT_TYPES: {},
      sanitizeAlphaNum: (value) => value,
    },
    [path.join(repoRoot, 'utils', 'security.js')]: {
      createProcessKey: () => 'process-key',
    },
    [path.join(repoRoot, 'services', 'registrationAudit.js')]: {
      appendActivationCodeUsage: async () => {},
    },
    [path.join(repoRoot, 'services', 'codeHistory.js')]: {
      listAdminActivationHistory: async () => historyResult,
    },
  }, () => require(routePath));
}

function loadDashboardRouter({ leadershipTraceRows, directReferralCount }) {
  const routePath = path.join(repoRoot, 'routes', 'dashboard.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      memberAuth: (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        query: async (sql) => {
          if (sql.includes('SELECT COUNT(*) AS total FROM usertab WHERE drefid = ?')) {
            return [[{ total: directReferralCount }]];
          }
          return [[]];
        },
      },
    },
    [path.join(repoRoot, 'utils', 'helpers.js')]: {
      getAccountTypeName: () => 'Gold',
      currentMonthRange: () => ({ start: '2026-06-01', end: '2026-06-30' }),
    },
    [path.join(repoRoot, 'services', 'income', 'calculateAndStoreIncome.js')]: {
      calculateAndStoreIncome: async () => ({}),
    },
    [path.join(repoRoot, 'services', 'income', 'unilevel.js')]: {
      getProjectedCurrentMonthUnilevel: async () => 0,
      getUnilevelProductPointContributors: async () => ({ totalPoints: 0, projectedAmount: 0, maxReach: 0, rows: [] }),
    },
    [path.join(repoRoot, 'services', 'income', 'leadership.js')]: {
      getLeadershipTraceability: async () => ({
        totalSources: leadershipTraceRows.length,
        byLevel: {
          level1: 250,
          level2: 0,
          level35: 0,
        },
        rows: leadershipTraceRows,
      }),
    },
    [path.join(repoRoot, 'services', 'accountState.js')]: {
      getEffectiveAccountState: async () => null,
      getAccountEntryAuditInfo: () => ({}),
    },
  }, () => require(routePath));
}

function loadEncashmentRouter({ encashmentRows, summary }) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'encashment.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        query: async () => [encashmentRows],
      },
    },
    [path.join(repoRoot, 'services', 'adminReporting.js')]: {
      buildEncashmentSummary: () => summary,
      buildEncashmentExportRows: () => encashmentRows.map((row) => ({
        Date: row.cashtransdate,
        'Full Name': row.fullname,
        Username: row.username,
        'Gross Encashment': Number(row.encashment1 || 0) + Number(row.tax_1 || 0) + Number(row.encashmentfee || 0) + Number(row.cddeduction || 0),
        'Net Receivable': Number(row.encashment1 || 0),
        Tax: Number(row.tax_1 || 0),
        Fee: Number(row.encashmentfee || 0),
        'CD Deduction': Number(row.cddeduction || 0),
        'Total Deductions': Number(row.tax_1 || 0) + Number(row.encashmentfee || 0) + Number(row.cddeduction || 0),
        'Payout Option': 'GCash',
        'Payout Details': row.paymentdetails,
        Status: Number(row.cashstatus || 0) === 1 ? 'Paid' : 'Pending',
      })),
    },
    [path.join(repoRoot, 'services', 'payoutOptions.js')]: {
      resolvePayoutOption: () => ({ id: 1, label: 'GCash' }),
    },
  }, () => require(routePath));
}

function loadCdAccountsRouter({ rows, exportRows, packageBreakdown, settlementState }) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'cdAccounts.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        query: async () => [rows],
      },
    },
    [path.join(repoRoot, 'services', 'adminReporting.js')]: {
      buildCdPackageBreakdown: () => packageBreakdown,
      buildCdExportRows: () => exportRows,
    },
    [path.join(repoRoot, 'services', 'cdAccountsPolicy.js')]: {
      deriveCdSettlementState: () => settlementState,
    },
  }, () => require(routePath));
}

test('admin finance export returns CSV content', async () => {
  const router = loadFinanceRouter({
    year: 2026,
    totals: {
      totalPackagesSold: 3,
      grossSales: 3000,
      expenseReserveWallet: 1200,
      projectedOperatingMargin: 1800,
    },
    packageRows: [
      {
        packageLabel: 'Gold',
        soldCount: 3,
        packageAmount: 1000,
        grossSales: 3000,
        productCost: 200,
        productCostTotal: 600,
        salesMatchCeiling: 150,
        salesMatchReserveTotal: 450,
        directReferralFixed: 100,
        directReferralTotal: 300,
        adminExtraCost: 50,
        adminExtraTotal: 150,
        reservePerCode: 500,
        reserveTotal: 1500,
        projectedOperatingMargin: 1500,
        notes: 'Reviewed',
      },
    ],
    wallets: {
      expenseReserveWallet: 1200,
      encashmentWallet: {
        requestedAmount: 800,
        netPayout: 650,
        paidOut: 500,
        pendingPayout: 150,
      },
      serviceAndMaintenanceWallet: {
        total: 75,
        taxAmount: 40,
        processingFee: 15,
        maintenanceFee: 20,
      },
      cdRecoveryWallet: {
        totalCdDeduction: 60,
      },
    },
  });
  const handlers = getRouteHandlers(router, 'get', '/export');
  const req = { query: { year: '2026' }, session: { adminid: 1 } };
  const res = createDownloadResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /finance-report-2026\.csv/);
  assert.match(String(res.body), /Finance Summary/);
  assert.match(String(res.body), /Package Accounting/);
});

test('admin codes history export returns CSV content', async () => {
  const router = loadCodesRouter({
    rows: [
      {
        code: 'ABC123',
        eventLabel: 'Generated',
        summary: 'Code generated',
        actorUsername: 'admin',
        actorAdminName: 'Super Admin',
        fromUsername: '',
        toUsername: '',
        createdAt: '2026-06-04 09:00:00',
        processKey: 'process-1',
      },
    ],
    totalPages: 1,
  });
  const handlers = getRouteHandlers(router, 'get', '/history/export');
  const req = { query: {}, session: { adminid: 1 } };
  const res = createDownloadResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /activation-code-history\.csv/);
  assert.match(String(res.body), /ABC123/);
  assert.match(String(res.body), /Generated/);
});

test('member leadership export returns CSV content', async () => {
  const router = loadDashboardRouter({
    directReferralCount: 4,
    leadershipTraceRows: [
      {
        uid: 11,
        username: 'downline1',
        fullName: 'Downline One',
        level: 1,
        ratePercent: 5,
        pairingIncome: 5000,
        leadershipBonus: 250,
        directReferralCount: 2,
      },
    ],
  });
  const handlers = getRouteHandlers(router, 'get', '/breakdown/:metric/export');
  const req = { params: { metric: 'leadership-bonus' }, query: {}, session: { uid: 55 } };
  const res = createDownloadResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /leadership-bonus-breakdown\.csv/);
  assert.match(String(res.body), /Downline One/);
  assert.match(String(res.body), /OVERALL TOTAL/);
});

test('admin encashment export returns CSV content', async () => {
  const encashmentRows = [
    {
      pid: 1,
      uid: 22,
      cashtransdate: '2026-06-04',
      cashstatus: 0,
      cddeduction: 25,
      encashment1: 200,
      tax_1: 20,
      encashmentfee: 10,
      paymentoptions: 'GCash',
      paymentdetails: '09171234567',
      payoutid: 1,
      payoutdetails: '09171234567',
      username: 'member1',
      firstname: 'Member',
      lastname: 'One',
      fullname: 'Member One',
    },
  ];
  const router = loadEncashmentRouter({
    encashmentRows,
    summary: {
      overview: {
        totalRecords: 1,
        grossEncashment: 255,
        netReceivable: 200,
        totalDeductions: 55,
        totalCdDeduction: 25,
      },
      daily: [
        {
          date: '2026-06-04',
          totalRecords: 1,
          uniqueMembers: 1,
          grossEncashment: 255,
          netReceivable: 200,
          totalTax: 20,
          totalFee: 10,
          totalCdDeduction: 25,
          totalDeductions: 55,
          paidCount: 0,
          pendingCount: 1,
        },
      ],
    },
  });
  const handlers = getRouteHandlers(router, 'get', '/export');
  const req = { query: {}, session: { adminid: 1 } };
  const res = createDownloadResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /encashment-report-all-latest\.csv/);
  assert.match(String(res.body), /Encashments/);
  assert.match(String(res.body), /Member One/);
});

test('admin CD accounts export returns CSV content', async () => {
  const rows = [
    {
      uid: 33,
      username: 'cdmember',
      firstname: 'CD',
      lastname: 'Member',
      currentaccttype: 30,
      codeid: 3,
      cdstatus: 1,
      cdamount: 1000,
      cdtotal: 400,
      regdate: '2026-06-01',
      deductionCount: 2,
      encashmentCount: 2,
      netEncashment: 300,
      totalCdDeduction: 200,
      firstDeductionDate: '2026-06-02',
      lastDeductionDate: '2026-06-03',
    },
  ];
  const router = loadCdAccountsRouter({
    rows,
    exportRows: [
      {
        Username: 'cdmember',
        'Full Name': 'CD Member',
        Package: 'Gold',
        'CD Status': 'Still Paying',
        'CD Amount': 1000,
        'CD Paid': 400,
        'CD Remaining': 600,
      },
    ],
    packageBreakdown: [
      {
        package: 'Gold',
        totalAccounts: 1,
        fullyPaid: 0,
        stillPaying: 1,
        totalCdAmount: 1000,
        totalPaid: 400,
        totalRemaining: 600,
        totalDeductionCount: 2,
        totalEncashmentCount: 2,
        totalNetEncashment: 300,
      },
    ],
    settlementState: {
      remaining: 600,
      recoveredRemaining: 600,
      statusLabel: 'Still Paying',
      isRecoveredFullyPaid: false,
      isSettledOutsideDeduction: false,
    },
  });
  const handlers = getRouteHandlers(router, 'get', '/export');
  const req = { query: {}, session: { adminid: 1 } };
  const res = createDownloadResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /cd-accounts-all-all\.csv/);
  assert.match(String(res.body), /CD Accounts/);
  assert.match(String(res.body), /cdmember/);
});
