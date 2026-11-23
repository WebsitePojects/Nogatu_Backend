const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const repoRoot = path.resolve(__dirname, '..', '..');
const servicePath = path.join(repoRoot, 'services', 'incomeReport.js');
const routePath = path.join(repoRoot, 'routes', 'admin', 'incomeReport.js');
const dbPath = path.join(repoRoot, 'config', 'database.js');

const {
  buildIncomeReleaseReport,
  buildIncomeReleaseWorkbook,
  PAYOUT_MONTH_SQL,
  SELECT_COUNT,
} = require(servicePath);

/** Fake conn: records SQL, answers by which table the statement reads. */
function fakeConn(answers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM (SELECT uid')) return [answers.smbCredits || []];
      if (sql.includes('FROM payouthistorytab')) return [answers.income || []];
      if (sql.includes("THEN 'pre' ELSE")) return [answers.memberBase || []];
      if (sql.includes('FROM usertab')) return [answers.registrations || []];
      if (sql.includes('FROM upgradetab')) return [answers.upgrades || []];
      if (sql.includes('FROM repurchasetab')) return [answers.repurchases || []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('range validation throws INVALID_RANGE before any DB query', async () => {
  const bad = [
    {},
    { from: '2026-10' },
    { to: '2026-10' },
    { from: '2026-13', to: '2026-14' },
    { from: '2026-1', to: '2026-10' },
    { from: '2026-10-01', to: '2026-10' },
    { from: '2026-10', to: '2026-09' },
    { from: '2024-01', to: '2026-01' }, // 25 months
    { from: '0000-01', to: '0000-02' }, // year out of bounds
    { from: '2101-01', to: '2101-02' },
  ];
  for (const params of bad) {
    const conn = fakeConn();
    await assert.rejects(
      () => buildIncomeReleaseReport(params, conn),
      (err) => err.code === 'INVALID_RANGE'
    );
    assert.equal(conn.calls.length, 0, `queries issued for ${JSON.stringify(params)}`);
  }
});

test('24-month span is accepted', async () => {
  const conn = fakeConn();
  const report = await buildIncomeReleaseReport({ from: '2025-01', to: '2026-12' }, conn);
  assert.equal(report.months.length, 24);
});

test('query count is constant regardless of month count', async () => {
  const one = fakeConn();
  const many = fakeConn();
  await buildIncomeReleaseReport({ from: '2026-10', to: '2026-10' }, one);
  await buildIncomeReleaseReport({ from: '2025-01', to: '2026-12' }, many);
  assert.equal(one.calls.length, SELECT_COUNT);
  assert.equal(many.calls.length, SELECT_COUNT);
});

test('payouthistorytab SQL carries the Manila clock adjustment and a sargable prefilter', async () => {
  const conn = fakeConn();
  await buildIncomeReleaseReport({ from: '2026-10', to: '2026-11' }, conn);
  assert.match(PAYOUT_MONTH_SQL, /transdate \+ INTERVAL 8 HOUR/);
  assert.match(PAYOUT_MONTH_SQL, /transdate >= '2026-06-01'/);
  const payoutCalls = conn.calls.filter((c) => c.sql.includes('FROM payouthistorytab'));
  assert.equal(payoutCalls.length, 2); // income + smb credits
  for (const c of payoutCalls) {
    assert.ok(c.sql.includes('+ INTERVAL 8 HOUR'), 'clock adjust missing');
    assert.ok(c.sql.includes('transdate >= ? AND transdate <= ?'), 'raw prefilter missing');
    // prefilter is one day wider than the Manila window on both sides
    assert.deepEqual(c.params, ['2026-09-30 00:00:00', '2026-12-02 23:59:59', '2026-10-01', '2026-12-01']);
  }
});

test('queries are read-only', async () => {
  const conn = fakeConn();
  await buildIncomeReleaseReport({ from: '2026-10', to: '2026-10' }, conn);
  for (const c of conn.calls) assert.match(c.sql.trim(), /^SELECT\b/);
});

test('shapes income by type 1..6, buckets months, rounds, and computes averages', async () => {
  const conn = fakeConn({
    income: [
      {
        month: '2026-10', earners: 4,
        amt_directReferral: '1000.005', cnt_directReferral: '2', earn_directReferral: '2',
        amt_smb: '2500.10', cnt_smb: '5', earn_smb: '3',
        amt_leadership: '100', cnt_leadership: '1', earn_leadership: '1',
        amt_unilevel: '50.555', cnt_unilevel: '2', earn_unilevel: '2',
        amt_hiFive: '0', cnt_hiFive: '0', earn_hiFive: '0',
        amt_ranking: '0', cnt_ranking: '0', earn_ranking: '0',
      },
      { month: '2099-01', earners: 9 }, // outside range: ignored
    ],
    registrations: [
      { month: '2026-10', accttype: 30, codeid: 1, n: 2 },
      { month: '2026-10', accttype: 30, codeid: 3, n: 1 },
      { month: '2026-10', accttype: 10, codeid: 2, n: 1 },
    ],
    upgrades: [{ month: '2026-10', producttype: 40, n: 3 }],
    repurchases: [
      { month: '2026-10', producttype: 100, n: 2, points: 100 },
      { month: '2026-10', producttype: 999, n: 5, points: 0 },
    ],
  });
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-10' }, conn);
  assert.deepEqual(report.months.map((m) => m.month), ['2026-09', '2026-10']);
  const [sep, oct] = report.months;

  const t = oct.income.byType;
  assert.equal(t.directReferral.amount, 1000.01);
  assert.equal(t.smb.amount, 2500.1);
  assert.equal(t.smb.credits, 5);
  assert.equal(t.smb.earners, 3);
  assert.equal(t.leadership.amount, 100);
  assert.equal(t.unilevel.amount, 50.56);
  assert.equal(oct.income.total, 3650.67);
  assert.equal(oct.income.earners, 4);

  const reg = oct.codes.registrations;
  assert.equal(reg.total, 4);
  assert.deepEqual(reg.byPackage[30], { PD: 2, FS: 0, CD: 1, total: 3 });
  assert.deepEqual(reg.byPackage[10], { PD: 0, FS: 1, CD: 0, total: 1 });
  assert.equal(reg.packageValue, 3 * 10000 + 2500);
  assert.equal(oct.codes.upgrades.byPackage[40], 3);
  assert.equal(oct.codes.upgrades.total, 3);
  assert.equal(oct.codes.repurchases.total, 7);
  assert.equal(oct.codes.repurchases.amount, 1700); // 2 x 850, unknown product has no price
  assert.equal(oct.codes.repurchases.points, 100);

  assert.equal(oct.averages.incomePerRegistration, 912.67);
  assert.equal(oct.averages.incomePerEarner, 912.67);
  assert.equal(oct.averages.payoutRatio, 0.1123); // 4 dp: a fraction shown as a percent

  // empty month: zero shape, null averages
  assert.equal(sep.income.total, 0);
  assert.equal(sep.averages.incomePerRegistration, null);
  assert.equal(sep.averages.incomePerEarner, null);
  assert.equal(sep.averages.payoutRatio, null);

  assert.equal(report.totals.income.total, 3650.67);
  assert.equal(report.totals.codes.registrations.total, 4);
  assert.equal(report.totals.averages.payoutRatio, 0.1123);
  assert.deepEqual(Object.keys(report.totals), Object.keys(oct).filter((k) => k !== 'month'));
});

test('SMB distribution: cumulative members, zero derived, buckets mapped', async () => {
  const conn = fakeConn({
    memberBase: [
      { pkg: 30, bucket: 'pre', n: 10 },
      { pkg: 30, bucket: '2026-10', n: 2 },
      { pkg: 10, bucket: 'pre', n: 5 },
    ],
    smbCredits: [
      { month: '2026-09', pkg: 30, one_two: 3, three_four: 2, five_plus: 1 },
      { month: '2026-10', pkg: 30, one_two: 1, three_four: 0, five_plus: 0 },
    ],
  });
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-10' }, conn);
  const [sep, oct] = report.months;
  assert.deepEqual(sep.smbDistribution.byPackage[30], { zero: 4, oneToTwo: 3, threeToFour: 2, fivePlus: 1, members: 10, creditMembersOutsideBase: 0 });
  assert.deepEqual(oct.smbDistribution.byPackage[30], { zero: 11, oneToTwo: 1, threeToFour: 0, fivePlus: 0, members: 12, creditMembersOutsideBase: 0 });
  assert.equal(oct.smbDistribution.byPackage[10].zero, 5);
  assert.equal(report.totals.smbDistribution.byPackage[30].members, 22);
});

test('works without a conn argument (default pool resolved lazily)', async () => {
  const saved = require.cache[dbPath];
  const stub = fakeConn();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: stub } };
  try {
    const report = await buildIncomeReleaseReport({ from: '2026-10', to: '2026-10' });
    assert.equal(report.months.length, 1);
    assert.equal(stub.calls.length, SELECT_COUNT);
  } finally {
    if (saved) require.cache[dbPath] = saved;
    else delete require.cache[dbPath];
  }
});

test('workbook has 3 sheets with widths set, frozen header, and notes', async () => {
  const conn = fakeConn();
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-10' }, conn);
  const wb = buildIncomeReleaseWorkbook(report);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Monthly Summary', 'SMB Distribution', 'Notes']);
  for (const ws of wb.worksheets) {
    assert.ok(ws.columns.length > 0);
    for (const col of ws.columns) assert.ok(col.width >= 6, `${ws.name}/${col.header} width`);
    assert.equal(ws.views[0].state, 'frozen');
  }
  assert.equal(wb.getWorksheet('Monthly Summary').rowCount, 1 + 2 + 1); // header + months + TOTAL
  assert.equal(wb.getWorksheet('SMB Distribution').rowCount, 1 + 3 * 6);
  const text = wb.getWorksheet('Notes').getColumn(1).values.join(' ');
  for (const needle of ['payouthistorytab', '+8 hours', 'handed over physically', 'Legacy SMB', 'CD codes are credit']) {
    assert.ok(text.includes(needle), `notes missing: ${needle}`);
  }
});

// ---- route -----------------------------------------------------------------

function loadRoute(serviceStub) {
  const saved = require.cache[servicePath];
  if (serviceStub) {
    require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: serviceStub };
  }
  delete require.cache[routePath];
  const router = require(routePath);
  delete require.cache[routePath];
  if (serviceStub) {
    if (saved) require.cache[servicePath] = saved;
    else delete require.cache[servicePath];
  }
  return router;
}

function routeOf(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/income-release');
  assert.ok(layer, 'route missing');
  return layer.route;
}

function fakeRes() {
  const stream = new PassThrough();
  stream.headers = {};
  stream.statusCode = 200;
  stream.setHeader = (k, v) => { stream.headers[k.toLowerCase()] = v; };
  stream.status = (c) => { stream.statusCode = c; return stream; };
  stream.json = (b) => { stream.body = b; return stream; };
  return stream;
}

test('route is GET /income-release, guarded by adminAuth + adminRights([1,3])', () => {
  const route = routeOf(loadRoute());
  assert.ok(route.methods.get);
  assert.equal(route.stack.length, 3);
  const rights = route.stack[1].handle;
  for (const [adminrights, allowed] of [[1, true], [3, true], [2, false], [4, false], [undefined, false]]) {
    let nexted = false;
    const res = fakeRes();
    rights({ session: { adminrights } }, res, () => { nexted = true; });
    assert.equal(nexted, allowed, `rights ${adminrights}`);
    if (!allowed) assert.equal(res.statusCode, 403);
  }
});

test('route maps INVALID_RANGE to 400 and other errors to generic 500', async () => {
  const real = routeOf(loadRoute()).stack[2].handle;
  const res = fakeRes();
  await real({ query: { from: '2026-10', to: '2026-01' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /"from" must not be after "to"/);

  const boom = routeOf(loadRoute({
    buildIncomeReleaseReport: async () => { throw new Error('secret db detail'); },
    buildIncomeReleaseWorkbook: () => { throw new Error('unused'); },
  })).stack[2].handle;
  const res2 = fakeRes();
  const origErr = console.error;
  console.error = () => {};
  try {
    await boom({ query: { from: '2026-10', to: '2026-10' } }, res2);
  } finally {
    console.error = origErr;
  }
  assert.equal(res2.statusCode, 500);
  assert.equal(res2.body.error, 'Failed to build income report');
});

test('route streams xlsx with the expected filename', async () => {
  const conn = fakeConn();
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-10' }, conn);
  const handler = routeOf(loadRoute({
    buildIncomeReleaseReport: async () => report,
    buildIncomeReleaseWorkbook,
  })).stack[2].handle;
  const res = fakeRes();
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => res.on('end', resolve));
  await handler({ query: { from: '2026-09', to: '2026-10', format: 'xlsx' } }, res);
  await done;
  assert.equal(
    res.headers['content-disposition'],
    'attachment; filename="Nogatu_Income_Release_2026-09_to_2026-10.xlsx"'
  );
  assert.match(res.headers['content-type'], /spreadsheetml/);
  assert.equal(Buffer.concat(chunks).subarray(0, 2).toString(), 'PK'); // zip magic
});

test('SMB zero bucket excludes credit holders outside the member base instead of clamping', async () => {
  const conn = fakeConn({
    memberBase: [{ pkg: 30, bucket: 'pre', n: 10 }],
    // 6 credit members, 2 of whom the base cannot see (registered later / no datereg)
    smbCredits: [{ month: '2026-09', pkg: 30, one_two: 3, three_four: 2, five_plus: 1, outside_base: 2 }],
  });
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  const cell = report.months[0].smbDistribution.byPackage[30];
  assert.equal(cell.creditMembersOutsideBase, 2);
  assert.equal(cell.zero, 6); // 10 in base - (6 credit members - 2 outside)
  const smbSql = conn.calls.find((c) => c.sql.includes('FROM (SELECT uid')).sql;
  assert.match(smbSql, /AS outside_base/);
});

test('repurchases with no catalog price are counted, never valued at 0 silently', async () => {
  const conn = fakeConn({ repurchases: [{ month: '2026-09', producttype: 999, n: 4, points: 0 }] });
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  assert.equal(report.months[0].codes.repurchases.unpriced, 4);
  assert.equal(report.months[0].codes.repurchases.amount, 0);
  assert.equal(report.totals.codes.repurchases.unpriced, 4);
});

test('registrations and member base use the Manila clock shift (Node-era datereg is UTC)', async () => {
  const conn = fakeConn();
  await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  const usertabCalls = conn.calls.filter((c) => /FROM usertab\s/.test(c.sql) && !c.sql.includes('FROM (SELECT uid'));
  assert.equal(usertabCalls.length, 2);
  for (const c of usertabCalls) assert.match(c.sql, /datereg \+ INTERVAL 8 HOUR/);
  const regs = usertabCalls.find((c) => c.sql.includes('GROUP BY month, accttype, codeid'));
  assert.match(regs.sql, /datereg >= \? AND datereg <= \?/); // sargable prefilter kept
  // The month BUCKET itself must be shifted, not just the range filter.
  assert.match(regs.sql, /SELECT DATE_FORMAT\(CASE WHEN datereg >= '2026-06-01' THEN datereg \+ INTERVAL 8 HOUR/);
  const base = usertabCalls.find((c) => c.sql.includes("THEN 'pre' ELSE"));
  assert.match(base.sql, /ELSE DATE_FORMAT\(CASE WHEN datereg >= '2026-06-01' THEN datereg \+ INTERVAL 8 HOUR/);
});

test('xlsx build failure returns a clean 500, not a truncated download', async () => {
  const conn = fakeConn();
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  const handler = routeOf(loadRoute({
    buildIncomeReleaseReport: async () => report,
    buildIncomeReleaseWorkbook: () => ({ xlsx: { writeBuffer: async () => { throw new Error('zip failed'); } } }),
  })).stack[2].handle;
  const res = fakeRes();
  const origErr = console.error;
  console.error = () => {};
  try {
    await handler({ query: { from: '2026-09', to: '2026-09', format: 'xlsx' } }, res);
  } finally {
    console.error = origErr;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers['content-disposition'], undefined);
});

test('registrations with a non-package account type are counted, not dropped', async () => {
  const conn = fakeConn({ registrations: [
    { month: '2026-09', accttype: 30, codeid: 1, n: 3 },
    { month: '2026-09', accttype: 100, codeid: 100, n: 2 },
  ] });
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  const reg = report.months[0].codes.registrations;
  assert.equal(reg.total, 5);
  assert.equal(reg.otherAccountType, 2);
  assert.equal(reg.packageValue, 30000);
  assert.equal(report.totals.codes.registrations.otherAccountType, 2);
});

test('workbook formats the payout ratio as a percent and peso columns with 2 decimals', async () => {
  const conn = fakeConn();
  const report = await buildIncomeReleaseReport({ from: '2026-09', to: '2026-09' }, conn);
  const ws = buildIncomeReleaseWorkbook(report).getWorksheet('Monthly Summary');
  assert.equal(ws.getColumn('ratio').numFmt, '0.0%');
  assert.equal(ws.getColumn('incomeTotal').numFmt, '#,##0.00');
});
