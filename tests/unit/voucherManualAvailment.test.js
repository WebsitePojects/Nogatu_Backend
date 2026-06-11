const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

const {
  VOUCHER_MEMBER_DISCOUNT_PERCENT,
  USED_VOUCHER_EXPIRY_DAYS,
  computeVoucherMemberPricing,
  normalizeVoucherAvailmentItems,
  computeVoucherAvailmentBalanceUpdate,
  computeVoucherManualAvailmentWalletUpdate,
  resolveVoucherAvailmentClaimUpdate,
  resolveInitialVoucherAvailmentClaimState,
} = require('../../services/voucher');

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

function loadAdminCodesRouter() {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'codes.js');
  delete require.cache[routePath];

  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: (roles = []) => {
        const middleware = (req, res, next) => next();
        middleware.allowedRoles = roles;
        return middleware;
      },
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: async () => { throw new Error('not used'); } },
    },
    [path.join(repoRoot, 'services', 'codeGeneration.js')]: {
      generateCodes: async () => [],
    },
    [path.join(repoRoot, 'services', 'registrationAudit.js')]: {
      appendActivationCodeUsage: async () => {},
    },
    [path.join(repoRoot, 'services', 'codeHistory.js')]: {
      listAdminActivationHistory: async () => ({ rows: [], total: 0, page: 1, totalPages: 1 }),
    },
    [path.join(repoRoot, 'services', 'csvExport.js')]: {
      buildSectionedCsv: () => '',
      sendCsv: () => {},
    },
  }, () => require(routePath));
}

test('manual voucher availment totals all ER items from valid lines only', () => {
  const normalized = normalizeVoucherAvailmentItems([
    { description: ' Signature Facial ', amount: '1500' },
    { description: 'Wellness kit', amount: '2500.50' },
    { description: '', amount: '999' },
    { description: 'Invalid amount', amount: '-1' },
    { description: 'Body sculpting', amount: 3000 },
  ]);

  assert.deepEqual(normalized.items, [
    { lineNo: 1, description: 'Signature Facial', amount: 1500 },
    { lineNo: 2, description: 'Wellness kit', amount: 2500.5 },
    { lineNo: 3, description: 'Body sculpting', amount: 3000 },
  ]);
  assert.equal(normalized.totalAmount, 7000.5);
});

test('manual voucher availment product dropdown defaults to discounted member price but allows manual override', () => {
  const normalized = normalizeVoucherAvailmentItems([
    { productCode: 102 },
    { productKey: 'cm', amount: '400' },
  ]);
  const glcPricing = computeVoucherMemberPricing(500);
  const cmPricing = computeVoucherMemberPricing(495);

  assert.deepEqual(normalized.items, [
    {
      lineNo: 1,
      description: 'Vitamin C with Collagen & Glutathione',
      amount: glcPricing.memberPrice,
      productCode: 102,
      productKey: 'glc',
      originalPrice: glcPricing.originalPrice,
      discountValue: glcPricing.discountValue,
      discountPercent: VOUCHER_MEMBER_DISCOUNT_PERCENT,
    },
    {
      lineNo: 2,
      description: 'Nogatu Coffee Mix',
      amount: 400,
      productCode: 103,
      productKey: 'cm',
      originalPrice: cmPricing.originalPrice,
      discountValue: cmPricing.discountValue,
      discountPercent: VOUCHER_MEMBER_DISCOUNT_PERCENT,
    },
  ]);
  assert.equal(normalized.totalAmount, glcPricing.memberPrice + 400);
});

test('manual voucher availment starts used-expiry countdown on first use', () => {
  const result = computeVoucherAvailmentBalanceUpdate({
    voucher: {
      package_type: 20,
      voucher_amount: 5000,
      remaining_balance: 5000,
      first_used_at: null,
      use_expires_at: null,
    },
    previousTotal: 0,
    nextTotal: 1250,
    now: '2026-06-11T10:30:00Z',
  });

  assert.equal(result.remainingBalance, 3750);
  assert.equal(result.status, 1);
  assert.equal(result.firstUsedAt, '2026-06-11T10:30:00.000Z');
  assert.equal(
    result.useExpiresAt,
    new Date(Date.parse('2026-06-11T10:30:00Z') + (USED_VOUCHER_EXPIRY_DAYS[20] * 86400000)).toISOString()
  );
});

test('manual voucher availment edit reuses first-use window and can fully consume the voucher', () => {
  const result = computeVoucherAvailmentBalanceUpdate({
    voucher: {
      package_type: 30,
      voucher_amount: 10000,
      remaining_balance: 7000,
      first_used_at: '2026-06-01T08:00:00.000Z',
      use_expires_at: '2026-07-16T08:00:00.000Z',
    },
    previousTotal: 3000,
    nextTotal: 10000,
    now: '2026-06-11T10:30:00Z',
  });

  assert.equal(result.remainingBalance, 0);
  assert.equal(result.status, 3);
  assert.equal(result.firstUsedAt, '2026-06-01T08:00:00.000Z');
  assert.equal(result.useExpiresAt, '2026-07-16T08:00:00.000Z');
});

test('manual voucher availment requires matching wallet cash and adjusts edit deltas', () => {
  const created = computeVoucherManualAvailmentWalletUpdate({
    walletBalance: 1000,
    previousTotal: 0,
    nextTotal: 500,
  });

  assert.equal(created.cashDelta, 500);
  assert.equal(created.walletBalance, 500);
  assert.equal(created.cashPaid, 500);
  assert.equal(created.totalValue, 1000);

  const editedDown = computeVoucherManualAvailmentWalletUpdate({
    walletBalance: 500,
    previousTotal: 500,
    nextTotal: 300,
  });

  assert.equal(editedDown.cashDelta, -200);
  assert.equal(editedDown.walletBalance, 700);
  assert.equal(editedDown.cashPaid, 300);
  assert.equal(editedDown.totalValue, 600);
});

test('manual voucher availment rejects when wallet cannot match voucher usage', () => {
  assert.throws(
    () => computeVoucherManualAvailmentWalletUpdate({
      walletBalance: 499,
      previousTotal: 0,
      nextTotal: 500,
    }),
    /Insufficient wallet balance/
  );
});

test('voucher request claim update only allows requested entries to be marked claimed', () => {
  assert.deepEqual(
    resolveVoucherAvailmentClaimUpdate({ currentStatus: 'requested', now: '2026-06-11T13:00:00Z' }),
    { nextStatus: 'claimed', claimedAt: '2026-06-11T13:00:00.000Z' }
  );

  assert.throws(
    () => resolveVoucherAvailmentClaimUpdate({ currentStatus: 'claimed' }),
    /already claimed/
  );
});

test('cashier manual voucher entries start as claimed while member requests stay requested', () => {
  assert.deepEqual(
    resolveInitialVoucherAvailmentClaimState({
      requestSource: 'cashier',
      actorAdminId: 7,
      actorAdmin: 'Nogatu Cashier',
      claimDate: '2026-06-11T13:00:00Z',
    }),
    {
      claimStatus: 'claimed',
      claimedAt: '2026-06-11T13:00:00.000Z',
      claimedByAdminId: 7,
      claimedByAdmin: 'Nogatu Cashier',
    }
  );

  assert.deepEqual(
    resolveInitialVoucherAvailmentClaimState({
      requestSource: 'member',
      actorAdminId: 7,
      actorAdmin: 'Nogatu Cashier',
      claimDate: '2026-06-11T13:00:00Z',
    }),
    {
      claimStatus: 'requested',
      claimedAt: null,
      claimedByAdminId: null,
      claimedByAdmin: null,
    }
  );
});

test('cashier keeps generate-codes access in the admin router', () => {
  const router = loadAdminCodesRouter();
  const handlers = getRouteHandlers(router, 'post', '/generate');
  const roleGuard = handlers.find((handler) => Array.isArray(handler.allowedRoles));

  assert.deepEqual(roleGuard?.allowedRoles, [1, 2, 3]);
});
