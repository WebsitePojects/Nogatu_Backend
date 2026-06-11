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

function loadVoucherManagementRouter(options = {}) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'voucherManagement.js');
  delete require.cache[routePath];

  const schemaRequirementSet = {
    VOUCHERS: 'VOUCHERS',
    VOUCHER_TRANSACTIONS: 'VOUCHER_TRANSACTIONS',
    VOUCHER_GRANTS: 'VOUCHER_GRANTS',
    VOUCHER_LIST: 'VOUCHER_LIST',
  };
  const queryResults = options.queryResults || [
    [[{ total: 1 }]],
    [[{
      id: 101,
      uid: 7001,
      package_type: 10,
      voucher_amount: 2500,
      remaining_balance: 2500,
      status: 1,
      suspend_reason: null,
      issued_at: '2026-06-11 10:00',
      expiry_at: '2026-08-11 10:00',
      first_used_at: null,
      use_expires_at: null,
      username: 'member001',
      firstname: 'Member',
      lastname: 'One',
    }]],
    [[{ allCount: 1, activeCount: 1, expiredCount: 0, fullyUsedCount: 0, suspendedCount: 0 }]],
  ];
  const getVoucherAvailments = options.getVoucherAvailments || (async () => []);

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        query: async () => queryResults.shift() || [[]],
        getConnection: async () => ({}),
      },
    },
    [path.join(repoRoot, 'services', 'voucher.js')]: {
      PACKAGE_AMOUNTS: { 10: 2500 },
      UNUSED_VOUCHER_EXPIRY_MONTHS: { 10: 2 },
      buildVoucherExpiryLabel: () => 'Active',
      createManualVoucherAvailment: async () => ({}),
      grantVouchersToExistingMembers: async () => 0,
      getVoucherExpiryMode: () => 'unused',
      getVoucherAvailmentById: async () => ({}),
      getVoucherAvailments,
      listVoucherGrantCandidates: async () => ({
        users: [{
          uid: 7001,
          username: 'member001',
          fullname: 'Member One',
          accttype: 10,
          voucherAmount: 2500,
          hasVoucher: false,
          voucherId: null,
          voucherRemaining: null,
          voucherStatus: null,
          datereg: '2026-06-11 10:00',
        }],
        total: 1,
        page: 1,
        totalPages: 1,
        perPage: 30,
      }),
      markVoucherAvailmentClaimed: async () => ({}),
      updateManualVoucherAvailment: async () => ({}),
    },
    [path.join(repoRoot, 'services', 'schemaReadiness.js')]: {
      SCHEMA_REQUIREMENTS: schemaRequirementSet,
      assertSchemaRequirements: async (requirement) => {
        if (requirement === schemaRequirementSet.VOUCHERS) {
          const error = new Error('Voucher management is not ready. Please run database migrations.');
          error.code = 'SCHEMA_NOT_READY';
          throw error;
        }
      },
    },
  }, () => require(routePath));
}

function getMatchingHandlers(router, method, routePath) {
  const handlers = [];

  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      handlers.push(...layer.route.stack.map((entry) => entry.handle));
      continue;
    }

    if (!layer.route && typeof layer.handle === 'function') {
      handlers.push(layer.handle);
    }
  }

  return handlers;
}

async function runHandlers(handlers, req, res) {
  async function dispatch(index) {
    const handler = handlers[index];
    if (!handler) return;

    const maybePromise = handler(req, res, (err) => {
      if (err) throw err;
      return dispatch(index + 1);
    });

    if (maybePromise && typeof maybePromise.then === 'function') {
      await maybePromise;
    }
  }

  await dispatch(0);
}

test('voucher list loads granted vouchers when manual availment schema is not ready', async () => {
  const router = loadVoucherManagementRouter();
  const handlers = getMatchingHandlers(router, 'get', '/');
  const req = {
    query: { page: '1', status: 'all' },
    session: { adminid: 1, rights: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vouchers.length, 1);
  assert.equal(res.body.vouchers[0].id, 101);
  assert.equal(res.body.vouchers[0].username, 'member001');
  assert.equal(res.body.counts.active, 1);
});

test('voucher grant candidates still load when full voucher ledger schema is not ready', async () => {
  const router = loadVoucherManagementRouter();
  const handlers = getMatchingHandlers(router, 'get', '/grant-candidates');
  const req = {
    query: { page: '1' },
    session: { adminid: 1, rights: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.users.length, 1);
  assert.equal(res.body.users[0].username, 'member001');
});

test('voucher transactions load from legacy transaction schema when manual availment schema is not ready', async () => {
  const router = loadVoucherManagementRouter({
    queryResults: [[[
      {
        id: 9,
        transaction_date: '2026-06-11 20:17',
        cash_paid: 386,
        voucher_used: 386,
        total_value: 772,
      },
    ]]],
  });
  const handlers = getMatchingHandlers(router, 'get', '/:id/transactions');
  const req = {
    params: { id: '2' },
    session: { adminid: 1, rights: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.transactions.length, 1);
  assert.equal(res.body.transactions[0].type, 'Voucher Redemption');
  assert.equal(res.body.transactions[0].reference, 'VTX-9');
  assert.equal(res.body.transactions[0].amount, 386);
});

test('voucher availment list returns empty when manual availment schema is not ready', async () => {
  const router = loadVoucherManagementRouter();
  const handlers = getMatchingHandlers(router, 'get', '/:id/availments');
  const req = {
    params: { id: '2' },
    session: { adminid: 1, rights: 1 },
  };
  const res = createResponse();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.availments, []);
});
