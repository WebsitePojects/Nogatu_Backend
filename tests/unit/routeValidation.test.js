const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

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

function loadRegistrationRouter({ registerMember }) {
  const routePath = path.join(repoRoot, 'routes', 'registration.js');
  delete require.cache[routePath];

  const poolStub = {
    query: async (sql) => {
      if (sql.includes('SELECT username FROM memberstab')) {
        return [[{ username: 'placement-user' }]];
      }
      if (sql.includes('SELECT currentaccttype, accttype FROM usertab')) {
        return [[{ currentaccttype: 10, accttype: 10 }]];
      }
      return [[]];
    },
  };

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      memberAuth: (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: poolStub,
    },
    [path.join(repoRoot, 'services', 'registration.js')]: {
      registerMember,
      checkDuplicateName: async () => ({ isDuplicate: false, matches: [] }),
      getAvailableCodes: async () => [],
      previewActivationCode: async () => ({ valid: true }),
      checkUsername: async () => false,
      getAccountId: async () => 1,
      checkPlacementSlots: async () => false,
      getAvailablePosition: async () => 1,
    },
    [path.join(repoRoot, 'services', 'income', 'calculateAndStoreIncome.js')]: {
      calculateAndStoreIncome: async () => {},
    },
    [path.join(repoRoot, 'services', 'audit.js')]: {
      writeAuditLog: async () => {},
    },
    [path.join(repoRoot, 'services', 'placementRecommendation.js')]: {
      recommendPlacementForSponsor: async () => ({
        placementUid: 222,
        position: 2,
        side: 'right',
        strategy: 'manual',
      }),
    },
    [path.join(repoRoot, 'services', 'binaryPlacementPolicy.js')]: {
      getPlacementPolicyForSponsor: async () => ({ mode: 'manual', reason: 'manual', forcedPosition: null }),
      placementPolicyMessage: () => 'Manual placement is allowed.',
    },
  }, () => require(routePath));
}

function loadAdminAccountsRouter({ connection }) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'accounts.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        getConnection: async () => connection,
        query: async () => [[]],
      },
    },
    [path.join(repoRoot, 'services', 'audit.js')]: {
      writeAuditLog: async () => {},
    },
  }, () => require(routePath));
}

function loadWalletRouter({ calculateAndStoreIncome, getMemberGlobalBonus, assertTinPresentForEncashment, getEncashmentPreview, insertEncashment }) {
  const routePath = path.join(repoRoot, 'routes', 'wallet.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        query: async () => [[{ total: 0 }]],
      },
    },
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      memberAuth: (req, res, next) => next(),
    },
    [path.join(repoRoot, 'services', 'income', 'calculateAndStoreIncome.js')]: {
      calculateAndStoreIncome: calculateAndStoreIncome || (async () => ({
        ttlincome1: 100,
        ttlincome2: 200,
        ttlincome3: 300,
        ttlincome4: 400,
        ttlincome5: 500,
        ttlincome6: 600,
        ttlcashbalance: 2100,
      })),
    },
    [path.join(repoRoot, 'services', 'income', 'insertIncome.js')]: {
      getEncashmentPreview: getEncashmentPreview || (async () => ({
        payout: { ok: true },
        sufficientBalance: true,
      })),
      insertEncashment: insertEncashment || (async () => ({
        pid: 1,
        cdDeduction: 0,
        maintenanceFee: 20,
        netReceivable: 100,
        newBalance: 500,
      })),
    },
    [path.join(repoRoot, 'services', 'globalBonus.js')]: {
      getMemberGlobalBonus: getMemberGlobalBonus || (async () => ({
        eligible: false,
        visibilityState: 'locked',
        interactive: false,
        fullVisibility: false,
        labels: [],
        portions: 0,
      })),
    },
    [path.join(repoRoot, 'services', 'memberTinPolicy.js')]: {
      assertTinPresentForEncashment: assertTinPresentForEncashment || (async () => '123-456-789'),
    },
  }, () => require(routePath));
}

function getRouteHandlers(router, method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${routePath} should exist`);
  return layer.route.stack.map((entry) => entry.handle);
}

test('member registration requires an address but allows TIN to be omitted', async () => {
  const calls = [];
  const router = loadRegistrationRouter({
    registerMember: async (payload) => {
      calls.push(payload);
      return {
        success: true,
        uid: 9001,
        position: payload.position,
        placementUid: payload.placementUid,
        placementPolicy: payload.placementPolicy,
      };
    },
  });

  const handlers = getRouteHandlers(router, 'post', '/register');

  const missingAddressReq = {
    body: {
      activationCode: 'PDBR12345678',
      username: 'newmember',
      password: 'password123',
      firstname: 'Alice',
      lastname: 'Reyes',
      email: 'alice@example.com',
      contactno: '09171234567',
      dob: '1991-02-02',
    },
    session: { uid: 101, currentaccttype: 10, accttype: 10 },
  };
  const missingAddressRes = createResponse();

  await runHandlers(handlers, missingAddressReq, missingAddressRes);
  assert.equal(missingAddressRes.statusCode, 400);
  assert.deepEqual(missingAddressRes.body, { error: 'All required fields must be filled' });

  const successReq = {
    body: {
      activationCode: 'PDBR12345678',
      username: 'newmember',
      password: 'password123',
      firstname: 'Alice',
      lastname: 'Reyes',
      email: 'alice@example.com',
      address: '123 Sampaguita St.',
      contactno: '09171234567',
      dob: '1991-02-02',
      position: 1,
    },
    session: { uid: 101, currentaccttype: 10, accttype: 10 },
    requestId: 'req-1',
  };
  const successRes = createResponse();

  await runHandlers(handlers, successReq, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tin, '');
  assert.equal(calls[0].address, '123 Sampaguita St.');
});

test('wallet summary exposes rankingBonus but not deprecated LPC fields', async () => {
  const router = loadWalletRouter({});
  const handlers = getRouteHandlers(router, 'get', '/');
  const req = {
    session: { uid: 44, currentaccttype: 30 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rankingBonus, 600);
  assert.equal('lpc' in res.body, false);
  assert.equal('legacyIncome6' in res.body, false);
});

test('wallet summary totalIncome sums credited income streams without double-counting cash balance', async () => {
  const router = loadWalletRouter({
    calculateAndStoreIncome: async () => ({
      ttlincome1: 6250,
      ttlincome2: 397750,
      ttlincome3: 29307.5,
      ttlincome4: 0,
      ttlincome5: 0,
      ttlincome6: 0,
      ttlcashbalance: 2000,
    }),
  });
  const handlers = getRouteHandlers(router, 'get', '/');
  const req = {
    session: { uid: 44, currentaccttype: 30 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalIncome, 433307.5);
  assert.equal(res.body.cashBalance, 2000);
});

test('wallet encashment preview returns 422 when TIN is missing', async () => {
  const tinError = new Error('TIN is required before encashment. Please complete your account profile first.');
  tinError.code = 'TIN_REQUIRED_FOR_ENCASHMENT';
  tinError.statusCode = 422;

  const router = loadWalletRouter({
    assertTinPresentForEncashment: async () => { throw tinError; },
  });
  const handlers = getRouteHandlers(router, 'post', '/preview-encash');
  const req = {
    body: { amount: 1000 },
    session: { uid: 44, currentaccttype: 30 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    error: 'TIN is required before encashment. Please complete your account profile first.',
    code: 'TIN_REQUIRED_FOR_ENCASHMENT',
  });
});

test('wallet encashment submit returns 422 when TIN is missing', async () => {
  const tinError = new Error('TIN is required before encashment. Please complete your account profile first.');
  tinError.code = 'TIN_REQUIRED_FOR_ENCASHMENT';
  tinError.statusCode = 422;

  const router = loadWalletRouter({
    assertTinPresentForEncashment: async () => { throw tinError; },
  });
  const handlers = getRouteHandlers(router, 'post', '/encash');
  const req = {
    body: { amount: 1000 },
    session: { uid: 44, currentaccttype: 30 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    error: 'TIN is required before encashment. Please complete your account profile first.',
    code: 'TIN_REQUIRED_FOR_ENCASHMENT',
  });
});

test('admin account status route accepts frozen as a first-class account status', async () => {
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql) => {
      if (sql.includes('SELECT uid, account_status, account_status_reason')) {
        return [[{
          uid: 77,
          account_status: 'active',
          account_status_reason: null,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  const router = loadAdminAccountsRouter({ connection });
  const handlers = getRouteHandlers(router, 'put', '/:uid/status');
  const req = {
    params: { uid: '77' },
    body: { status: 'frozen', reason: 'Chargeback review' },
    session: { adminid: 9 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    accountStatus: 'frozen',
    accountStatusReason: 'Chargeback review',
  });
});
