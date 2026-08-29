/**
 * Manage Codes: status filter + custom rows-per-page (management request 2026-08-27).
 *
 * Asserts on the SQL the route ACTUALLY issues, not on a helper in isolation, so a
 * filter that is built but never reaches the count/page/export queries fails here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

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

function getRouteHandlers(router, method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method]);
  assert.ok(layer, 'Route ' + method.toUpperCase() + ' ' + routePath + ' should exist');
  return layer.route.stack.map((entry) => entry.handle);
}

async function runHandlers(handlers, req, res) {
  async function dispatch(i) {
    const handler = handlers[i];
    if (!handler) return;
    const maybe = handler(req, res, (err) => { if (err) throw err; return dispatch(i + 1); });
    if (maybe && typeof maybe.then === 'function') await maybe;
  }
  await dispatch(0);
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p !== undefined) this.body = p; return this; },
    write() { return true; },
  };
}

// Loads the real codes router with a pool that RECORDS every query it is asked to run.
function loadCodesRouter(opts) {
  const options = opts || {};
  const tablesPresent = options.tablesPresent || ['codehistorytab', 'activation_code_usagetab'];
  const routePath = path.join(repoRoot, 'routes', 'admin', 'codes.js');
  delete require.cache[routePath];
  const queries = [];

  const pool = {
    query: async (sql, params) => {
      const boundParams = params || [];
      queries.push({ sql: String(sql), params: boundParams });
      if (/^SHOW TABLES LIKE/i.test(String(sql).trim())) {
        return [tablesPresent.includes(boundParams[0]) ? [{ t: boundParams[0] }] : []];
      }
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0 }]];
      return [[]];
    },
  };

  const router = withStubbedModules({
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: { pool },
    [path.join(repoRoot, 'services', 'codeGeneration.js')]: {
      generateCodes: async () => [], validateCodeGenerationRequest: () => ({ ok: true }),
    },
    [path.join(repoRoot, 'utils', 'helpers.js')]: { PRODUCT_TYPES: {}, sanitizeAlphaNum: (v) => v },
    [path.join(repoRoot, 'utils', 'security.js')]: { createProcessKey: () => 'k' },
    [path.join(repoRoot, 'services', 'registrationAudit.js')]: { appendActivationCodeUsage: async () => {} },
    [path.join(repoRoot, 'services', 'codeHistory.js')]: { listAdminActivationHistory: async () => ({ rows: [] }) },
    [path.join(repoRoot, 'services', 'xlsxExport.js')]: { buildCodesWorkbook: () => ({ xlsx: { write: async () => {}, writeBuffer: async () => Buffer.from('') } }) },
    [path.join(repoRoot, 'services', 'codeTrail.js')]: { parseInitialRecipient: () => null },
    [path.join(repoRoot, 'services', 'leaders.js')]: { findLeadersForMember: async () => ({}) },
  }, () => require(routePath));

  return { router, queries };
}

async function listWith(query, opts) {
  const options = opts || {};
  const loaded = loadCodesRouter(options);
  const res = makeRes();
  await runHandlers(getRouteHandlers(loaded.router, 'get', '/'), {
    query: query,
    session: { adminrights: options.adminrights === undefined ? 1 : options.adminrights, adminid: 'admin' },
  }, res);
  const data = loaded.queries.filter((q) => !/^SHOW TABLES LIKE/i.test(q.sql.trim()));
  return { res, queries: data };
}

const countQuery = (qs) => qs.find((q) => /COUNT\(\*\)/i.test(q.sql));
const pageQuery = (qs) => qs.find((q) => /FROM codestab c/i.test(q.sql) && !/COUNT\(\*\)/i.test(q.sql));

test('no status filter leaves the existing rights cap untouched', async () => {
  const r = await listWith({});
  assert.match(countQuery(r.queries).sql, /c\.codestatus <= 2/);
  assert.doesNotMatch(countQuery(r.queries).sql, /c\.codestatus = /);
});

for (const pair of [['not_released', 'c.codestatus = 0'], ['released', 'c.codestatus = 1'], ['used', 'c.codestatus = 2']]) {
  test('status=' + pair[0] + ' constrains BOTH the count and the page query', async () => {
    const r = await listWith({ status: pair[0] });
    assert.ok(countQuery(r.queries).sql.includes(pair[1]), 'count query missing ' + pair[1]);
    assert.ok(pageQuery(r.queries).sql.includes(pair[1]), 'page query missing ' + pair[1]);
  });
}

test('status=transferred matches legacy history OR a Node-era transfer event', async () => {
  const r = await listWith({ status: 'transferred' });
  const sql = countQuery(r.queries).sql;
  assert.match(sql, /EXISTS \(SELECT 1 FROM codehistorytab h WHERE h\.code = c\.code\)/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM activation_code_usagetab a WHERE a\.code = c\.code/);
  assert.deepEqual(countQuery(r.queries).params, ['transfer', 'admin_transfer']);
});

test('status=transferred does NOT constrain codestatus - a Used code can be transferred', async () => {
  const r = await listWith({ status: 'transferred' });
  assert.doesNotMatch(countQuery(r.queries).sql, /c\.codestatus = /);
});

test('status=transferred falls back to the surviving table when one is absent', async () => {
  const r = await listWith({ status: 'transferred' }, { tablesPresent: ['activation_code_usagetab'] });
  const sql = countQuery(r.queries).sql;
  assert.doesNotMatch(sql, /codehistorytab/);
  assert.match(sql, /activation_code_usagetab/);
});

test('status=transferred FAILS CLOSED (matches nothing) when no evidence table exists', async () => {
  const r = await listWith({ status: 'transferred' }, { tablesPresent: [] });
  assert.match(countQuery(r.queries).sql, /1 = 0/);
});

test('an unknown status is REJECTED with 400 and issues zero data queries', async () => {
  const r = await listWith({ status: 'everything' });
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.queries.length, 0, 'a rejected filter must not reach the database');
});

test('a blank status behaves as all, not as a rejection', async () => {
  const r = await listWith({ status: '' });
  assert.equal(r.res.statusCode, 200);
});

test('status is case-insensitive', async () => {
  const r = await listWith({ status: 'Not_Released' });
  assert.equal(r.res.statusCode, 200);
  assert.match(countQuery(r.queries).sql, /c\.codestatus = 0/);
});

test('cashier stays capped: status=used cannot lift the codestatus <= 1 restriction', async () => {
  const r = await listWith({ status: 'used' }, { adminrights: 2 });
  const sql = countQuery(r.queries).sql;
  assert.match(sql, /c\.codestatus <= 1/);
  assert.match(sql, /c\.codestatus = 2/);
});

test('rows-per-page: custom value is honoured', async () => {
  const r = await listWith({ perPage: '250' });
  assert.equal(pageQuery(r.queries).params.at(-1), 250);
});

test('rows-per-page: defaults to 40 and is bounded at 500', async () => {
  assert.equal(pageQuery((await listWith({})).queries).params.at(-1), 40);
  assert.equal(pageQuery((await listWith({ perPage: '5000' })).queries).params.at(-1), 500);
  assert.equal(pageQuery((await listWith({ perPage: '0' })).queries).params.at(-1), 40);
  assert.equal(pageQuery((await listWith({ perPage: 'abc' })).queries).params.at(-1), 40);
});

test('the export route applies the same status filter', async () => {
  const loaded = loadCodesRouter();
  const res = makeRes();
  await runHandlers(getRouteHandlers(loaded.router, 'get', '/export'), {
    query: { status: 'released' }, session: { adminrights: 1, adminid: 'admin' },
  }, res);
  const data = loaded.queries.filter((q) => !/^SHOW TABLES LIKE/i.test(q.sql.trim()));
  assert.ok(data.some((q) => q.sql.includes('c.codestatus = 1')), 'export ignored the status filter');
});

test('the export route rejects an unknown status with 400', async () => {
  const loaded = loadCodesRouter();
  const res = makeRes();
  await runHandlers(getRouteHandlers(loaded.router, 'get', '/export'), {
    query: { status: 'bogus' }, session: { adminrights: 1, adminid: 'admin' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(loaded.queries.filter((q) => !/^SHOW TABLES LIKE/i.test(q.sql.trim())).length, 0);
});
