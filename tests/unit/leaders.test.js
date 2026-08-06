'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Stub config/database BEFORE loading the service, so the DEFAULT (no-conn) code
// path — the one the route actually uses — is exercised for real. Every other test
// injects a connection, which would hide a broken default parameter entirely.
const dbPath = require.resolve('../../config/database');
const defaultPoolCalls = [];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: {
      async query(sql, params) {
        defaultPoolCalls.push({ sql, params });
        return [[{ uid: 428268, depth: 4 }]];
      },
    },
  },
};

const { LEADERS, LEADER_BY_UID, findNearestLeader, findLeadersForMember } =
  require('../../services/leaders');

// Fake connection: returns the ancestor chain we hand it, nearest-first, and
// records which SQL was used so we can prove the two trees are queried separately.
function fakeConn(chainBySql) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const key = sql.includes('drefid') ? 'drefid' : 'refid';
      return [chainBySql[key] || []];
    },
  };
}

test('roster is pinned by uid and internally consistent', () => {
  assert.strictEqual(LEADERS.length, 6);
  for (const l of LEADERS) {
    assert.ok(Number.isInteger(l.uid) && l.uid > 0, `${l.name} needs a real uid`);
    assert.ok(l.username && l.name, `${l.uid} needs username + name`);
    assert.strictEqual(LEADER_BY_UID.get(l.uid), l);
  }
  assert.strictEqual(new Set(LEADERS.map((l) => l.uid)).size, 6, 'uids must be unique');
});

test('returns the NEAREST leader when several sit in the same chain', async () => {
  // Jervy (428268) at depth 2, Rosalie (5726452) further up at depth 5.
  const conn = fakeConn({ drefid: [
    { uid: 999001, depth: 1 },
    { uid: 428268, depth: 2 },
    { uid: 999002, depth: 3 },
    { uid: 5726452, depth: 5 },
  ] });
  const got = await findNearestLeader(123, 'chain drefid', conn);
  assert.strictEqual(got.uid, 428268);
  assert.strictEqual(got.name, 'Jervy Latumbo');
  assert.strictEqual(got.depth, 2);
});

test('returns null when no leader is above the member', async () => {
  const conn = fakeConn({ drefid: [{ uid: 111, depth: 1 }, { uid: 222, depth: 2 }] });
  assert.strictEqual(await findNearestLeader(123, 'chain drefid', conn), null);
});

test('empty chain (root account) returns null, not a throw', async () => {
  const conn = fakeConn({ drefid: [] });
  assert.strictEqual(await findNearestLeader(123, 'chain drefid', conn), null);
});

test('invalid uid short-circuits without hitting the DB', async () => {
  const conn = fakeConn({});
  for (const bad of [0, -1, null, undefined, NaN, 'abc']) {
    assert.strictEqual(await findNearestLeader(bad, 'chain drefid', conn), null);
  }
  assert.strictEqual(conn.calls.length, 0, 'must not query for an invalid uid');
});

test('the two trees are resolved INDEPENDENTLY and can differ', async () => {
  const conn = fakeConn({
    drefid: [{ uid: 5726452, depth: 3 }],   // sponsor  -> Rosalie
    refid:  [{ uid: 1509809, depth: 1 }],   // binary   -> Rendell
  });
  const { unilevel, binary } = await findLeadersForMember(777, conn);
  assert.strictEqual(unilevel.name, 'Rosalie Mallari');
  assert.strictEqual(binary.name, 'Rendell Jimenez');
  assert.strictEqual(conn.calls.length, 2, 'one query per tree');
  assert.ok(conn.calls.some((c) => c.sql.includes('drefid')), 'sponsor tree must use drefid');
  assert.ok(conn.calls.some((c) => c.sql.includes('refid')),  'binary tree must use refid');
});

test('one tree can have a leader while the other has none', async () => {
  const conn = fakeConn({ drefid: [{ uid: 428268, depth: 1 }], refid: [{ uid: 555, depth: 1 }] });
  const { unilevel, binary } = await findLeadersForMember(777, conn);
  assert.strictEqual(unilevel.name, 'Jervy Latumbo');
  assert.strictEqual(binary, null);
});

// ── The path the route actually takes: called with NO connection argument ──
// Regression guard: an earlier revision defaulted to a `pool` identifier that no
// longer existed, so this threw ReferenceError on every real lookup while every
// conn-injecting test stayed green.
test('works when called WITHOUT a connection (the route’s real path)', async () => {
  defaultPoolCalls.length = 0;
  const { unilevel, binary } = await findLeadersForMember(999999);
  assert.strictEqual(unilevel.name, 'Jervy Latumbo');
  assert.strictEqual(binary.name, 'Jervy Latumbo');
  assert.strictEqual(defaultPoolCalls.length, 2, 'must fall back to the shared pool for both trees');
});

test('findNearestLeader also works with no connection argument', async () => {
  defaultPoolCalls.length = 0;
  const got = await findNearestLeader(999999, 'chain drefid');
  assert.strictEqual(got.uid, 428268);
  assert.strictEqual(defaultPoolCalls.length, 1);
});

// ── Source guarantees: this feature must stay read-only ──
test('leaders service performs no writes and touches no money table', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'leaders.js'), 'utf8');
  for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'payouttotaltab', 'payouthistorytab', 'ttlincome', 'ttlcashbalance']) {
    assert.ok(!src.toUpperCase().includes(forbidden.toUpperCase()),
      `leaders.js must never reference ${forbidden} — it is a read-only display feature`);
  }
});

test('recursive walk is depth-capped and cannot self-loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'leaders.js'), 'utf8');
  assert.match(src, /depth < \$\{MAX_DEPTH\}|depth < \d+/, 'chain walk must be depth-capped');
  assert.match(src, /p\.uid <> c\.uid/, 'must guard against a self-referencing root row');
});
