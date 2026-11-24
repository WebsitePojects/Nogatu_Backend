// Income per code: the replay must agree with the REAL engine (pairing.js getPairing,
// directReferral.js getDREF, leadership.js getLeadershipBonus) on random trees. The real engine
// runs against an in-memory fake pool, so any drift in the replay fails this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const dbPath = path.join(repoRoot, 'config', 'database.js');

let world = null; // { users: Map, upgrades: [], codes: Map(id -> codestab row), ttlincome2: Map }

function childrenOf(refid) {
  return [...world.users.values()].filter((u) => Number(u.refid) === Number(refid));
}
function latestUpgrade(uid) {
  const rows = world.upgrades
    .filter((u) => u.uid === uid && world.codes.has(u.codeid))
    .sort((a, b) => (a.transdate < b.transdate ? 1 : a.transdate > b.transdate ? -1 : b.id - a.id));
  if (!rows.length) return null;
  const c = world.codes.get(rows[0].codeid);
  return { uid, producttype: rows[0].producttype, upgradecodeid: rows[0].codeid, codetype: c.codetype, productamount: c.productamount };
}

const fakePool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ');
    if (/binary_tree_closuretab/.test(s)) { const e = new Error('no closure'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
    if (/FROM pairing_carry_resettab WHERE uid = \?/.test(s)) {
      const day = world.resets && world.resets.get(Number(params[0]));
      return [day ? [{ flush_day: day }] : []];
    }
    if (/FROM upgradetab u INNER JOIN codestab c/.test(s)) { const r = latestUpgrade(Number(params[0])); return [r ? [r] : []]; }
    if (/FROM upgradetab WHERE transtype = 1 AND uid = \?/.test(s)) {
      return [world.upgrades.filter((u) => u.uid === Number(params[0]))
        .sort((a, b) => (a.transdate < b.transdate ? -1 : a.transdate > b.transdate ? 1 : a.id - b.id))
        .map((u) => ({ uid: u.uid, transdate: u.transdate.slice(0, 10), binarypoints: u.binarypoints, transtype: 1 }))];
    }
    if (/SUM\(incentivepoints\)/.test(s)) {
      const ids = new Set(params.map(Number));
      return [[{ ttlIncentive: world.upgrades.filter((u) => ids.has(u.uid)).reduce((t, u) => t + u.incentivepoints, 0) }]];
    }
    if (/LEFT JOIN payouttotaltab p/.test(s)) {
      return [[...world.users.values()].filter((u) => u.drefid === Number(params[0])).sort((a, b) => a.uid - b.uid)
        .map((u) => ({ ...u, username: `m${u.uid}`, pairingIncome: world.ttlincome2.get(u.uid) || 0, directReferralCount: 0 }))];
    }
    if (/FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid WHERE u.refid = \?/.test(s)) {
      return [childrenOf(params[0]).map((u) => ({ ...u, username: `m${u.uid}` }))];
    }
    if (/FROM usertab WHERE refid = \?/.test(s)) return [childrenOf(params[0])];
    if (/FROM usertab WHERE drefid = \?/.test(s)) return [[...world.users.values()].filter((u) => u.drefid === Number(params[0]))];
    if (/FROM usertab WHERE uid = \? LIMIT 1/.test(s)) { const u = world.users.get(Number(params[0])); return [u ? [u] : []]; }
    throw new Error(`unrouted SQL: ${s.slice(0, 120)}`);
  },
};
require.cache[require.resolve(dbPath)] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };

const { getPairing } = require('../../services/income/pairing');
const { getDREF } = require('../../services/income/directReferral');
const { getLeadershipBonus } = require('../../services/income/leadership');
const { getEffectiveAccountState } = require('../../services/accountState');
const {
  computeIncomePerCode, indexSnapshot, collectOwnerEntries, replayOwnerPairing, resolveRange,
} = require('../../services/incomePerCode');
const { summarizeQualifiedDirectLegs } = require('../../services/binaryEligibility');

const PKG = [10, 20, 30, 40, 50, 60];
const BP = { 10: 250, 20: 500, 30: 1000, 40: 2500, 50: 5000, 60: 15000 };
const DR = { 10: 250, 20: 500, 30: 1000, 40: 2500, 50: 5000, 60: 15000 };

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

function buildWorld(seed, n = 70) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const users = new Map();
  const upgrades = [];
  const codes = new Map();
  const open = [{ uid: 1, pos: 1 }, { uid: 1, pos: 2 }];
  const day = (i) => `2026-0${6 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`;
  users.set(1, { uid: 1, refid: 0, drefid: 0, position: 1, accttype: 60, currentaccttype: 60, codeid: 1, cdamount: 0, cdtotal: 0, cdstatus: 0, binarypoints: BP[60], directreferral: DR[60], activationcode: 'C1', datereg: '2026-05-30 10:00:00' });
  let codeRow = 1;
  for (let uid = 2; uid <= n; uid += 1) {
    const slotIdx = Math.floor(r() * open.length);
    const slot = open.splice(slotIdx, 1)[0];
    open.push({ uid, pos: 1 }, { uid, pos: 2 });
    const accttype = pick(PKG.slice(0, 4));
    const codeid = pick([1, 1, 1, 2, 3, 3]);
    const cdstatus = codeid === 3 ? pick([1, 2]) : 0;
    const drefid = Math.max(1, Math.floor(r() * (uid - 1)) + 1);
    const datereg = `${day(Math.floor(r() * 80))} ${String(Math.floor(r() * 24)).padStart(2, '0')}:00:00`;
    const u = {
      uid, refid: slot.uid, drefid, position: slot.pos, accttype, currentaccttype: accttype, codeid,
      cdamount: codeid === 3 ? 2500 : 0, cdtotal: cdstatus === 2 ? 2500 : 0, cdstatus,
      binarypoints: BP[accttype], directreferral: DR[accttype], activationcode: `C${uid}`, datereg,
    };
    if (r() < 0.25) {
      u.currentaccttype = PKG[PKG.indexOf(accttype) + 1];
      codeRow += 1;
      codes.set(codeRow, { codetype: pick([1, 2, 3]), productamount: 10000 });
      upgrades.push({ id: upgrades.length + 1, uid, producttype: u.currentaccttype, binarypoints: BP[u.currentaccttype] - BP[accttype], incentivepoints: 100, codeid: codeRow, transdate: `${day(Math.floor(r() * 80))} 09:00:00` });
    }
    users.set(uid, u);
  }
  // Ownership-handover carry resets on a few owners (own generator, so the trees stay as before).
  const rr = rng(seed + 1000);
  const resets = new Map();
  for (let i = 0; i < 6; i += 1) {
    resets.set(1 + Math.floor(rr() * n), day(Math.floor(rr() * 80)));
  }
  return { users, upgrades, codes, ttlincome2: new Map(), resets };
}

function snapshotOf(w) {
  return {
    users: [...w.users.values()].map((u) => ({ ...u, username: `m${u.uid}` })),
    upgrades: w.upgrades.map((u) => ({ ...u, code_row_id: w.codes.has(u.codeid) ? u.codeid : null, code: `U${u.id}`, codetype: w.codes.get(u.codeid)?.codetype, productamount: 10000 })),
    regCodes: [],
    carryResets: [...(w.resets || new Map())].map(([uid, flushDay]) => ({ uid, flush_day: flushDay })),
  };
}

const ALL = resolveRange({ from: '2026-05', to: '2026-12' });

for (const seed of [1, 7, 42, 99, 2026]) {
  test(`replay equals the real engine per upline (seed ${seed})`, async () => {
    world = buildWorld(seed);
    const idx = await indexSnapshot(snapshotOf(world));
    let compared = 0;
    for (const uid of world.users.keys()) {
      const eff = await getEffectiveAccountState(uid);
      const cap = Number(eff.currentaccttype || eff.accttype);
      const real = await getPairing(uid, cap);
      const { left, right, directRows } = collectOwnerEntries(uid, cap, idx);
      const locked = !summarizeQualifiedDirectLegs(uid, directRows).canEarnPairing;
      if (real.eligibility) assert.equal(!locked, real.eligibility.canEarnPairing, `owner ${uid} eligibility`);
      const mine = replayOwnerPairing({ left, right, capAccttype: cap, locked, carryFlushDay: idx.carryFlushDays.get(uid) || null });
      assert.equal(mine.totalPay, real.totalPay, `owner ${uid}`);
      const attributed = [...mine.shares.values()].reduce((t, s) => t + s.amount, 0);
      assert.ok(Math.abs(attributed - mine.totalPay) < 1e-6, `owner ${uid} attribution ${attributed} vs ${mine.totalPay}`);
      world.ttlincome2.set(uid, real.totalPay);
      compared += 1;
    }
    assert.equal(compared, world.users.size);
  });

  test(`report DR and leadership equal the real engine (seed ${seed})`, async () => {
    world = buildWorld(seed);
    for (const uid of world.users.keys()) {
      const eff = await getEffectiveAccountState(uid);
      world.ttlincome2.set(uid, (await getPairing(uid, Number(eff.currentaccttype || eff.accttype))).totalPay);
    }
    const report = await computeIncomePerCode(ALL, snapshotOf(world));
    assert.equal(report.check.difference, 0);
    let realDr = 0;
    let realLead = 0;
    let realSmb = 0;
    for (const uid of world.users.keys()) {
      realDr += (await getDREF(uid)).directreferral;
      realLead += await getLeadershipBonus(uid);
      realSmb += world.ttlincome2.get(uid);
    }
    const sum = (k) => report.rows.reduce((t, row) => t + row[k], 0);
    assert.ok(Math.abs(sum('dr') - realDr) < 0.05, `DR ${sum('dr')} vs ${realDr}`);
    assert.ok(Math.abs(sum('smb') - realSmb) < 0.05 * report.rows.length, `SMB ${sum('smb')} vs ${realSmb}`);
    assert.ok(Math.abs(sum('leadership') - realLead) < 0.05 * report.rows.length, `leadership ${sum('leadership')} vs ${realLead}`);
    // FS and unpaid CD never feed SMB or DR.
    for (const row of report.rows.filter((x) => x.kind === 'Registration' && ['FS', 'CD'].includes(x.stateToday))) {
      assert.equal(row.dr, 0);
      assert.equal(row.smb, 0);
    }
  });
}

test('a Gold matched by a Gold on the other leg: PHP 1,000 for the upline, 500 on each code', async () => {
  world = { users: new Map(), upgrades: [], codes: new Map(), ttlincome2: new Map() };
  const base = { drefid: 1, accttype: 30, currentaccttype: 30, codeid: 1, cdamount: 0, cdtotal: 0, cdstatus: 0, binarypoints: 1000, directreferral: 1000 };
  world.users.set(1, { ...base, uid: 1, refid: 0, drefid: 0, position: 1, activationcode: 'A', datereg: '2026-07-01 08:00:00' });
  world.users.set(2, { ...base, uid: 2, refid: 1, position: 1, activationcode: 'L', datereg: '2026-07-02 08:00:00' });
  world.users.set(3, { ...base, uid: 3, refid: 1, position: 2, activationcode: 'R', datereg: '2026-07-03 08:00:00' });
  const report = await computeIncomePerCode(resolveRange({ from: '2026-07', to: '2026-07' }), snapshotOf(world));
  const byCode = Object.fromEntries(report.rows.map((x) => [x.code, x]));
  assert.equal(byCode.L.smb, 500);
  assert.equal(byCode.R.smb, 500);
  assert.equal(byCode.L.smbPaidMatches, 1);
  assert.equal(byCode.L.dr, 1000);
  assert.equal(report.check.engineTotal, 1000);
});

test('an upline without a personally sponsored direct pays 0 and the match is counted as blocked', async () => {
  world = { users: new Map(), upgrades: [], codes: new Map(), ttlincome2: new Map() };
  const base = { accttype: 30, currentaccttype: 30, codeid: 1, cdamount: 0, cdtotal: 0, cdstatus: 0, binarypoints: 1000, directreferral: 1000 };
  world.users.set(9, { ...base, uid: 9, refid: 0, drefid: 0, position: 1, activationcode: 'S', datereg: '2026-06-20 08:00:00' });
  world.users.set(1, { ...base, uid: 1, refid: 0, drefid: 9, position: 2, activationcode: 'A', datereg: '2026-07-01 08:00:00' });
  world.users.set(2, { ...base, uid: 2, refid: 1, drefid: 9, position: 1, activationcode: 'L', datereg: '2026-07-02 08:00:00' });
  world.users.set(3, { ...base, uid: 3, refid: 1, drefid: 9, position: 2, activationcode: 'R', datereg: '2026-07-03 08:00:00' });
  const report = await computeIncomePerCode(resolveRange({ from: '2026-07', to: '2026-07' }), snapshotOf(world));
  const byCode = Object.fromEntries(report.rows.map((x) => [x.code, x]));
  assert.equal(byCode.L.smb, 0);
  assert.equal(byCode.L.smbBlockedMatches, 1);
  assert.equal(report.check.engineTotal, (await getPairing(1, 30)).totalPay);
});

test('the snapshot is read with plain SELECTs only', () => {
  const { SNAPSHOT_QUERIES } = require('../../services/incomePerCode');
  for (const sql of Object.values(SNAPSHOT_QUERIES)) {
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
  }
});

test('range validation fails before any DB access', () => {
  assert.throws(() => resolveRange({ from: '2026-13', to: '2026-12' }), /YYYY-MM/);
  assert.throws(() => resolveRange({ from: '2026-08', to: '2026-07' }), /after/);
  assert.throws(() => resolveRange({ from: '2024-01', to: '2026-12' }), /24 months/);
});

test('weekly cap: a Bronze upline matched 15,000 in one week is paid 10,000, split 5,000 / 5,000', async () => {
  world = { users: new Map(), upgrades: [], codes: new Map(), ttlincome2: new Map() };
  const base = { codeid: 1, cdamount: 0, cdtotal: 0, cdstatus: 0 };
  world.users.set(1, { ...base, uid: 1, refid: 0, drefid: 0, position: 1, accttype: 10, currentaccttype: 10, binarypoints: 250, directreferral: 250, activationcode: 'A', datereg: '2026-07-01 08:00:00' });
  world.users.set(2, { ...base, uid: 2, refid: 1, drefid: 1, position: 1, accttype: 60, currentaccttype: 60, binarypoints: 15000, directreferral: 15000, activationcode: 'L', datereg: '2026-07-08 08:00:00' });
  world.users.set(3, { ...base, uid: 3, refid: 1, drefid: 1, position: 2, accttype: 60, currentaccttype: 60, binarypoints: 15000, directreferral: 15000, activationcode: 'R', datereg: '2026-07-09 08:00:00' });
  const report = await computeIncomePerCode(resolveRange({ from: '2026-07', to: '2026-07' }), snapshotOf(world));
  const byCode = Object.fromEntries(report.rows.map((x) => [x.code, x]));
  assert.equal((await getPairing(1, 10)).totalPay, 10000);
  assert.equal(report.check.engineTotal, 10000);
  assert.equal(byCode.L.smb, 5000);
  assert.equal(byCode.R.smb, 5000);
  assert.equal(byCode.L.smbCappedPoints + byCode.R.smbCappedPoints, 10000);
});

// ---- route ---------------------------------------------------------------------------

function perCodeRoute() {
  const routePath = path.join(repoRoot, 'routes', 'admin', 'incomeReport.js');
  delete require.cache[routePath];
  const router = require(routePath);
  const layer = router.stack.find((l) => l.route && l.route.path === '/income-per-code');
  assert.ok(layer, 'route missing');
  return layer.route;
}
function res() {
  const r = { statusCode: 200, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.sent = b; return r; };
  return r;
}

test('income-per-code: Super Admin / rights 3 only', () => {
  const route = perCodeRoute();
  const rights = route.stack[1].handle;
  for (const [adminrights, allowed] of [[1, true], [3, true], [2, false], [undefined, false]]) {
    let nexted = false;
    rights({ session: { adminrights } }, res(), () => { nexted = true; });
    assert.equal(nexted, allowed, `rights ${adminrights}`);
  }
});

test('income-per-code: bad range or code is refused before any DB connection', async () => {
  let connections = 0;
  fakePool.getConnection = async () => { connections += 1; throw new Error('must not connect'); };
  const handler = perCodeRoute().stack[2].handle;
  const r1 = res();
  await handler({ query: { from: '2026-09', to: '2026-01' } }, r1);
  assert.equal(r1.statusCode, 400);
  const r2 = res();
  await handler({ query: { from: '2026-01', to: '2026-02', code: "x' OR 1=1" } }, r2);
  assert.equal(r2.statusCode, 400);
  assert.equal(connections, 0);
});

test('income-per-code: a second build while one runs gets 429, then the first completes', async () => {
  world = buildWorld(3, 20);
  const snap = snapshotOf(world);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const statements = [];
  fakePool.getConnection = async () => ({
    async query(sql) {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/^START TRANSACTION READ ONLY/.test(sql)) { await gate; return [[]]; }
      if (/FROM usertab u\s+LEFT JOIN memberstab/.test(sql)) return [snap.users];
      if (/FROM upgradetab ut/.test(sql)) return [snap.upgrades];
      if (/GROUP_CONCAT/.test(sql)) return [[]];
      return [[]];
    },
    release() {},
  });
  const handler = perCodeRoute().stack[2].handle;
  const first = res();
  const running = handler({ query: { from: '2026-05', to: '2026-12' } }, first);
  await new Promise((r) => setImmediate(r));
  const second = res();
  await handler({ query: { from: '2026-05', to: '2026-12' } }, second);
  assert.equal(second.statusCode, 429);
  release();
  await running;
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.data.check.difference, 0);
  assert.equal(statements[0], 'START TRANSACTION READ');
  for (const s of statements) assert.doesNotMatch(s, /^(INSERT|UPDATE|DELETE)/i);
  const third = res();
  release();
  await handler({ query: { from: '2026-05', to: '2026-12' } }, third);
  assert.equal(third.statusCode, 200, 'guard released after completion');
});

test('carry reset: the previous owner\'s waiting codes earn nothing after the cutoff', () => {
  const e = (key, day, points) => ({ key, points, date: `${day} 00:00:00`, codeid: 1, sortTs: `${day} 01:00:00` });
  const left = [e('old', '2026-11-01', 1000), e('newL', '2026-11-22', 500)];
  const right = [e('newR', '2026-11-21', 500)];
  const withReset = replayOwnerPairing({ left, right, capAccttype: 60, locked: false, carryFlushDay: '2026-11-20 00:00:00' });
  assert.equal(withReset.totalPay, 500);
  assert.equal((withReset.shares.get('old') || { amount: 0 }).amount, 0);
  assert.equal(withReset.shares.get('newR').amount, 250);
  assert.equal(withReset.shares.get('newL').amount, 250);
  const control = replayOwnerPairing({ left, right, capAccttype: 60, locked: false });
  assert.equal(control.totalPay, 500);
  assert.equal(control.shares.get('old').amount, 250, 'control: without the reset the old code takes the match');
  assert.equal((control.shares.get('newL') || { amount: 0 }).amount, 0);
});
