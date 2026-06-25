const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
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
      if (cached) {
        require.cache[absolutePath] = cached;
      } else {
        delete require.cache[absolutePath];
      }
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

function loadAdminEncashmentRouter(poolStub) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'encashment.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: poolStub,
    },
  }, () => require(routePath));
}

function loadAdminRedeemRouter(poolStub) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'redeem.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: poolStub,
    },
  }, () => require(routePath));
}

function loadAdminCodesRouter({ poolStub, appendActivationCodeUsage }) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'codes.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: poolStub,
    },
    [path.join(repoRoot, 'services', 'registrationAudit.js')]: {
      appendActivationCodeUsage,
    },
  }, () => require(routePath));
}

function loadAdminGlobalBonusRouter(serviceStubs) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'globalBonus.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'services', 'globalBonus.js')]: serviceStubs,
  }, () => require(routePath));
}

function loadCalculateAndStoreIncome({
  poolStub,
  getDREF,
  getPairing,
  savePairingReport,
  getLeadershipBonus,
  checkLastMaintenance,
  checkUnilevelTransDate,
  getUnilevel,
  hasUnilevelCreditedThisMonth = async () => false,
  updateIncomeTransDate = async () => {},
  insertIncome,
  getEffectiveAccountState,
  getPackagePolicy,
  applyLifetimeIncomeCeiling,
}) {
  const servicePath = path.join(repoRoot, 'services', 'income', 'calculateAndStoreIncome.js');
  delete require.cache[servicePath];

  return withStubbedModules({
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: poolStub,
    },
    [path.join(repoRoot, 'services', 'income', 'directReferral.js')]: {
      getDREF,
    },
    [path.join(repoRoot, 'services', 'income', 'pairing.js')]: {
      getPairing,
      savePairingReport,
    },
    [path.join(repoRoot, 'services', 'income', 'leadership.js')]: {
      getLeadershipBonus,
    },
    [path.join(repoRoot, 'services', 'income', 'unilevel.js')]: {
      getUnilevel,
      checkLastMaintenance,
      checkUnilevelTransDate,
      hasUnilevelCreditedThisMonth,
      updateIncomeTransDate,
    },
    [path.join(repoRoot, 'services', 'income', 'insertIncome.js')]: {
      insertIncome,
    },
    [path.join(repoRoot, 'services', 'accountState.js')]: {
      getEffectiveAccountState,
    },
    [path.join(repoRoot, 'services', 'packagePolicy.js')]: {
      getPackagePolicy,
    },
    [path.join(repoRoot, 'services', 'income', 'incomeCapPolicy.js')]: {
      applyLifetimeIncomeCeiling,
    },
  }, () => require(servicePath));
}

test('calculateAndStoreIncome keeps payout persistence on the lock connection', async () => {
  const lockConn = {
    released: false,
    queryCalls: [],
    async query(sql) {
      this.queryCalls.push(sql);
      if (sql.includes('GET_LOCK')) {
        return [[{ lockState: 1 }]];
      }
      if (sql.includes('SELECT * FROM payouttotaltab')) {
        return [[{ ttlincome1: 0, ttlincome2: 0, ttlincome3: 0, ttlcashbalance: 20 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        return [[{ released: 1 }]];
      }
      return [[{ ttlincome1: 10, ttlcashbalance: 35 }]];
    },
    // C1 fix: the credit is wrapped in a transaction on the lock connection.
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {
      this.released = true;
    },
  };

  let insertConn = null;
  let reportConn = null;
  const poolStub = {
    getConnection: async () => lockConn,
    query: async (sql) => {
      throw new Error(`pool.query should not be used for locked payout persistence: ${sql}`);
    },
  };

  const { calculateAndStoreIncome } = loadCalculateAndStoreIncome({
    poolStub,
    getDREF: async () => ({ directreferral: 10 }),
    getPairing: async () => ({
      totalPay: 5,
      dailyReports: [{
        transdate: '2026-06-11',
        totalleft: 1,
        totalpointsleft: 5,
        totalright: 1,
        totalpointsright: 5,
        weeknumber: 24,
        left: 5,
        right: 5,
        totalpoints: 5,
        totalbpay: 5,
      }],
    }),
    savePairingReport: async (_uid, _reports, conn) => {
      reportConn = conn;
    },
    getLeadershipBonus: async () => 0,
    checkLastMaintenance: async () => false,
    checkUnilevelTransDate: async () => false,
    getUnilevel: async () => 0,
    insertIncome: async (_uid, _income, conn) => {
      insertConn = conn;
      return true;
    },
    getEffectiveAccountState: async () => ({}),
    getPackagePolicy: () => ({}),
    applyLifetimeIncomeCeiling: ({ proposedIncome }) => ({
      allowedIncome: proposedIncome,
      allowedTotal: Number(proposedIncome.dref || 0)
        + Number(proposedIncome.paircash || 0)
        + Number(proposedIncome.leadership || 0)
        + Number(proposedIncome.unilevel || 0)
        + Number(proposedIncome.hifive || 0),
    }),
  });

  await calculateAndStoreIncome(88, 30);

  assert.equal(insertConn, lockConn);
  assert.equal(reportConn, lockConn);
  assert.equal(lockConn.released, true);
});

test('admin encashment process rejects pid and uid mismatches before the update', async () => {
  const router = loadAdminEncashmentRouter({
    query: async (sql) => {
      if (sql.includes('SELECT uid FROM payouthistorytab WHERE pid = ?')) {
        return [[{ uid: 999 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  const handlers = getRouteHandlers(router, 'put', '/:pid/process');
  const req = {
    params: { pid: '10' },
    body: { uid: 123 },
    session: { adminid: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Encashment record does not belong to the supplied member.' });
});

test('admin redeem process rejects pid and uid mismatches before the update', async () => {
  const router = loadAdminRedeemRouter({
    query: async (sql) => {
      if (sql.includes('SELECT uid FROM h5historytab WHERE pid = ?')) {
        return [[{ uid: 777 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  const handlers = getRouteHandlers(router, 'put', '/:pid/process');
  const req = {
    params: { pid: '10' },
    body: { uid: 123 },
    session: { adminid: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Redemption record does not belong to the supplied member.' });
});

test('admin code release rolls back the code change when audit logging fails', async () => {
  const connection = {
    beginCount: 0,
    commitCount: 0,
    rollbackCount: 0,
    async beginTransaction() {
      this.beginCount += 1;
    },
    async commit() {
      this.commitCount += 1;
    },
    async rollback() {
      this.rollbackCount += 1;
    },
    release() {},
    async query(sql) {
      if (sql.includes('SELECT id, uid FROM codestab')) {
        return [[{ id: 1, uid: 11 }]];
      }
      if (sql.includes('UPDATE codestab SET releasedate = 1, codestatus = 1')) {
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const router = loadAdminCodesRouter({
    poolStub: {
      getConnection: async () => connection,
      query: (...args) => connection.query(...args),
    },
    appendActivationCodeUsage: async () => {
      throw new Error('audit failed');
    },
  });

  const handlers = getRouteHandlers(router, 'post', '/release');
  const req = {
    body: { codes: ['ABC123'] },
    session: { adminid: 'nogatuadmin', adminNumericId: 9 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 0);
  assert.equal(connection.rollbackCount, 1);
});

test('admin code release-transfer rolls back release and transfer writes on mid-flow failure', async () => {
  const connection = {
    beginCount: 0,
    commitCount: 0,
    rollbackCount: 0,
    async beginTransaction() {
      this.beginCount += 1;
    },
    async commit() {
      this.commitCount += 1;
    },
    async rollback() {
      this.rollbackCount += 1;
    },
    release() {},
    async query(sql) {
      if (sql.includes('SELECT uid, username, firstname, lastname FROM memberstab WHERE username = ?')) {
        return [[{ uid: 55, username: 'targetuser', firstname: 'Target', lastname: 'User' }]];
      }
      if (sql.includes('SELECT * FROM codestab WHERE code = ? AND codestatus <= 1')) {
        return [[{ id: 1, uid: 11, codestatus: 0, dategen: '2026-06-01 00:00:00' }]];
      }
      if (sql.includes('UPDATE codestab SET releasedate = 1, codestatus = 1')) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE codestab SET uid = ? WHERE code = ? AND codestatus = 1')) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO codehistorytab')) {
        throw new Error('history insert failed');
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const router = loadAdminCodesRouter({
    poolStub: {
      getConnection: async () => connection,
      query: (...args) => connection.query(...args),
    },
    appendActivationCodeUsage: async () => {},
  });

  const handlers = getRouteHandlers(router, 'post', '/release-transfer');
  const req = {
    body: { targetUsername: 'targetuser', codes: ['ABC123'] },
    session: { adminid: 'nogatuadmin', adminNumericId: 9 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 0);
  assert.equal(connection.rollbackCount, 1);
});

test('admin global bonus route rejects invalid future years before reaching the service layer', async () => {
  let called = false;
  const router = loadAdminGlobalBonusRouter({
    calculateGlobalBonus: async () => {
      called = true;
      return {};
    },
    distributeGlobalBonus: async () => {
      called = true;
      return {};
    },
    getGlobalBonusReport: async () => {
      called = true;
      return {};
    },
    getLatestPoolRecord: async () => null,
    searchGlobalBonusMembers: async () => [],
    addGlobalBonusMember: async () => ({}),
    removeGlobalBonusMember: async () => ({}),
    freezeGlobalBonusMember: async () => ({}),
    unfreezeGlobalBonusMember: async () => ({}),
  });

  const handlers = getRouteHandlers(router, 'get', '/preview');
  const req = {
    query: { year: '9999' },
    session: { adminid: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Year must be a 4-digit closed year.' });
  assert.equal(called, false);
});

test('admin account freeze source uses exact JSON uid matching instead of a LIKE pattern', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'routes', 'admin', 'accounts.js'),
    'utf8'
  );

  assert.match(source, /DELETE FROM app_sessions WHERE JSON_EXTRACT\(data, '\$\.uid'\) = \?/);
  assert.doesNotMatch(source, /DELETE FROM app_sessions WHERE data LIKE \?/);
});

test('pairing recursion guard treats zero as an explicit depth limit', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'services', 'income', 'pairing.js'),
    'utf8'
  );

  assert.match(source, /if \(pairingDepthLimit != null && level > pairingDepthLimit\)/);
});

test('encashment admin UI requires an explicit confirmation before mark-as-paid actions fire', () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'Nogatu_Frontend', 'src', 'pages', 'admin', 'Encashment.jsx'),
    'utf8'
  );

  assert.match(source, /This cannot be undone\./);
  assert.match(source, /confirm/i);
});
