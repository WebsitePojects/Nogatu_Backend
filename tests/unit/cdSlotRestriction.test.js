'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// CD Slot (codetype 3) may only be issued for GOLD (30) and PLATINUM (40)
// — management decision 2026-08-08. A CD code creates a standing 25%
// encashment-deduction obligation sized to the package, so issuing one against
// any other tier or a maintenance product creates an obligation the comp plan
// does not define.
//
// The Generate Codes form is a convenience; POST /api/admin/codes/generate takes
// a JSON body, so the RULE has to live on the server. These tests exercise the
// server path with the UI bypassed.

const repoRoot = path.resolve(__dirname, '..', '..');
const codeGenPath = path.join(repoRoot, 'services', 'codeGeneration.js');
const routePath = path.join(repoRoot, 'routes', 'admin', 'codes.js');

function withStubbedModules(stubs, loadModule) {
  const saved = new Map();
  for (const [absolutePath, exports] of Object.entries(stubs)) {
    saved.set(absolutePath, require.cache[absolutePath]);
    require.cache[absolutePath] = { id: absolutePath, filename: absolutePath, loaded: true, exports };
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

function loadCodeGeneration() {
  delete require.cache[codeGenPath];
  return withStubbedModules({
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: async () => [[{ maxId: 1000 }]], getConnection: async () => ({}) },
    },
  }, () => require(codeGenPath));
}

const {
  validateCodeGenerationRequest,
  isCdEligibleProductType,
  CD_ELIGIBLE_PRODUCT_TYPES,
} = loadCodeGeneration();

const PACKAGES = { BRONZE: 10, SILVER: 20, GOLD: 30, PLATINUM: 40, GARNET: 50, DIAMOND: 60 };
const CD = 3;
const PD = 1;
const FS = 2;

// ── The rule ─────────────────────────────────────────────────────────────

test('CD Slot is allowed for Gold and Platinum only', () => {
  assert.deepEqual(CD_ELIGIBLE_PRODUCT_TYPES, [PACKAGES.GOLD, PACKAGES.PLATINUM]);
  assert.equal(isCdEligibleProductType(PACKAGES.GOLD), true);
  assert.equal(isCdEligibleProductType(PACKAGES.PLATINUM), true);
  assert.equal(validateCodeGenerationRequest(PACKAGES.GOLD, CD).valid, true);
  assert.equal(validateCodeGenerationRequest(PACKAGES.PLATINUM, CD).valid, true);
});

test('CD Slot is REJECTED for every other package tier', () => {
  for (const tier of [PACKAGES.BRONZE, PACKAGES.SILVER, PACKAGES.GARNET, PACKAGES.DIAMOND]) {
    const result = validateCodeGenerationRequest(tier, CD);
    assert.equal(result.valid, false, `CD must be rejected for product type ${tier}`);
    assert.match(result.error, /CD Slot is only available for/);
    assert.match(result.error, /Gold and Platinum/);
  }
});

test('CD Slot is REJECTED for every maintenance product', () => {
  const { PRODUCT_CONFIG } = loadCodeGeneration();
  const maintenanceTypes = Object.keys(PRODUCT_CONFIG).map(Number).filter((t) => t >= 100);
  assert.ok(maintenanceTypes.length > 0, 'fixture check: maintenance products must exist');

  for (const productType of maintenanceTypes) {
    const result = validateCodeGenerationRequest(productType, CD);
    assert.equal(result.valid, false, `CD must be rejected for maintenance product ${productType}`);
  }
});

test('PD and FS remain allowed for every product type (the rule is CD-only)', () => {
  const { PRODUCT_CONFIG } = loadCodeGeneration();
  for (const productType of Object.keys(PRODUCT_CONFIG).map(Number)) {
    for (const codeType of [PD, FS]) {
      const result = validateCodeGenerationRequest(productType, codeType);
      assert.equal(result.valid, true,
        `product ${productType} + codeType ${codeType} must stay allowed`);
    }
  }
});

// ── Fail closed ──────────────────────────────────────────────────────────

test('an unknown product type is rejected, never defaulted', () => {
  for (const bogus of [0, 99, 999, -30, 'GOLD', null, undefined, NaN, 30.5]) {
    const result = validateCodeGenerationRequest(bogus, PD);
    assert.equal(result.valid, false, `product ${JSON.stringify(bogus)} must be rejected`);
  }
});

test('an unknown code type is rejected, never defaulted', () => {
  for (const bogus of [0, 4, 99, -1, null, undefined, NaN, 1.5, 'CD', '']) {
    const result = validateCodeGenerationRequest(PACKAGES.GOLD, bogus);
    assert.equal(result.valid, false, `codeType ${JSON.stringify(bogus)} must be rejected`);
  }
});

test('numeric STRINGS are coerced (a JSON body may send "3"), and the CD rule still applies', () => {
  // Deliberate: a form/JSON boundary can legitimately send "3"/"30" as strings, so
  // they are coerced rather than rejected. What must NOT happen is coercion letting
  // CD through on an ineligible package — the rule is applied to the numeric value.
  assert.equal(validateCodeGenerationRequest('30', '3').valid, true, 'CD on Gold, as strings');
  assert.equal(validateCodeGenerationRequest(PACKAGES.BRONZE, '3').valid, false, 'CD on Bronze, as string');
  assert.equal(validateCodeGenerationRequest('10', CD).valid, false, 'Bronze as string, CD');
  assert.equal(validateCodeGenerationRequest('60', '3').valid, false, 'Diamond + CD, both strings');
});

// ── The generator itself refuses, not just the route ─────────────────────

test('generateCodes THROWS on a disallowed CD request, so no caller can bypass the route', async () => {
  const { generateCodes } = loadCodeGeneration();
  await assert.rejects(
    () => generateCodes(1, PACKAGES.BRONZE, CD, 1, { adminUsername: 'tester' }),
    (err) => {
      assert.equal(err.code, 'INVALID_CODE_GENERATION_REQUEST');
      assert.match(err.message, /CD Slot is only available for/);
      return true;
    }
  );
});

test('generateCodes rejects BEFORE writing anything to the database', async () => {
  // The money assertion: a refused request must not reach codestab at all.
  delete require.cache[codeGenPath];
  const queries = [];
  const { generateCodes } = withStubbedModules({
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: {
        async query(sql) { queries.push(sql); return [[{ maxId: 1000 }]]; },
        async getConnection() {
          return {
            query: async (sql) => { queries.push(sql); return [[]]; },
            beginTransaction: async () => {}, commit: async () => {},
            rollback: async () => {}, release: () => {},
          };
        },
      },
    },
  }, () => require(codeGenPath));

  await assert.rejects(() => generateCodes(5, PACKAGES.DIAMOND, CD, 1, { adminUsername: 'tester' }));
  assert.deepEqual(queries, [], 'a rejected CD request must issue ZERO queries');
});

// ── Route boundary: the UI is bypassed ───────────────────────────────────

function loadCodesRouter() {
  delete require.cache[routePath];
  return withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: {
      pool: { query: async () => [[]], getConnection: async () => ({}) },
    },
  }, () => require(routePath));
}

function getRouteHandler(router, method, routeMatchPath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routeMatchPath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  return null;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('POST /generate returns 400 for a CD code on Bronze (raw request, no UI involved)', async () => {
  const router = loadCodesRouter();
  const handler = getRouteHandler(router, 'post', '/generate');
  assert.ok(handler, 'POST /generate must be registered');

  const res = createResponse();
  await handler(
    { body: { noOfCodes: 10, productType: PACKAGES.BRONZE, codeType: CD }, session: { adminid: 'admin' } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /CD Slot is only available for/);
});

test('POST /generate still accepts a CD code on Gold and Platinum', async () => {
  for (const tier of [PACKAGES.GOLD, PACKAGES.PLATINUM]) {
    const router = loadCodesRouter();
    const handler = getRouteHandler(router, 'post', '/generate');
    const res = createResponse();
    await handler(
      { body: { noOfCodes: 1, productType: tier, codeType: CD }, session: { adminid: 'admin' } },
      res
    );
    // Not a 400: the request passes validation. (It proceeds into the generator,
    // whose DB behaviour is covered separately.)
    assert.notEqual(res.statusCode, 400, `CD on product ${tier} must not be rejected`);
  }
});
