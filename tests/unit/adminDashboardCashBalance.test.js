/**
 * Admin dashboard: total cash balance across every member wallet (management request
 * 2026-11-03). The figure is a read of payouttotaltab.ttlcashbalance; these tests pin
 * that it is summed from that column, survives an empty table and a DECIMAL string,
 * and that the dashboard route issues no write.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

function loadDashboardRouter(cashRow) {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'dashboard.js');
  const stubs = {
    [path.join(repoRoot, 'middleware', 'auth.js')]: {
      adminAuth: (req, res, next) => next(),
      adminRights: () => (req, res, next) => next(),
    },
    [path.join(repoRoot, 'config', 'database.js')]: { pool: null },
  };
  const queries = [];
  stubs[path.join(repoRoot, 'config', 'database.js')].pool = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (/FROM payouttotaltab/i.test(text)) return [[cashRow]];
      if (/GROUP BY codeid, accttype/i.test(text)) return [[{ codeid: 1, accttype: 10, cnt: 3 }]];
      return [[{ cnt: 0, purchases: 0, total: 0 }]];
    },
  };

  const saved = new Map();
  delete require.cache[routePath];
  for (const [p, exports] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  try {
    return { router: require(routePath), queries };
  } finally {
    for (const [p, cached] of saved) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
  }
}

async function getDashboard(cashRow) {
  const { router, queries } = loadDashboardRouter(cashRow);
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  assert.ok(layer, 'GET / should exist');
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const handlers = layer.route.stack.map((s) => s.handle);
  const run = async (i) => {
    if (!handlers[i]) return;
    await handlers[i]({ session: {} }, res, () => run(i + 1));
  };
  await run(0);
  return { res, queries };
}

test('returns the summed wallet balance and the number of members holding one', async () => {
  const { res } = await getDashboard({ total: 2181699.55, holders: 1234 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalCashBalance, 2181699.55);
  assert.equal(res.body.membersWithCashBalance, 1234);
});

test('a DECIMAL returned as a string becomes a number', async () => {
  const { res } = await getDashboard({ total: '2181699.55', holders: '1234' });
  assert.equal(res.body.totalCashBalance, 2181699.55);
  assert.equal(res.body.membersWithCashBalance, 1234);
});

test('an empty wallet table reads as zero, not null or NaN', async () => {
  const { res } = await getDashboard({ total: null, holders: null });
  assert.equal(res.body.totalCashBalance, 0);
  assert.equal(res.body.membersWithCashBalance, 0);
});

test('the figure is summed from payouttotaltab.ttlcashbalance', async () => {
  const { queries } = await getDashboard({ total: 1, holders: 1 });
  const cash = queries.find((q) => /FROM payouttotaltab/i.test(q));
  assert.ok(cash, 'cash balance query should run');
  assert.match(cash, /SUM\(ttlcashbalance\)/i);
});

test('the dashboard route never writes', async () => {
  const { queries } = await getDashboard({ total: 1, holders: 1 });
  for (const q of queries) {
    assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b/i, q);
  }
});

test('existing dashboard fields are unchanged', async () => {
  const { res } = await getDashboard({ total: 1, holders: 1 });
  for (const key of ['totalAccounts', 'paidAccounts', 'freeSlots', 'cdSlots', 'totalPurchases',
    'weeklyActivations', 'totalEncashment', 'pendingEncashments', 'totalIncomePaidOut',
    'activeCdAccounts', 'newRegistrationsMonth']) {
    assert.ok(key in res.body, `missing ${key}`);
  }
  assert.equal(res.body.paidAccounts, 3);
});
