'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// services/voucher.js requires '../config/database' at module load (for `pool`).
// Stub it in require.cache BEFORE requiring the service, the way
// tests/unit/leaders.test.js does, so this file never touches mysql2/a real DB —
// including for services/schemaReadiness.js, which resolves the SAME absolute
// path via its own '../config/database' require.
const dbPath = require.resolve('../../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: {
      async query() {
        throw new Error('pool.query should never be hit — every call must use the injected conn');
      },
      async getConnection() {
        throw new Error('pool.getConnection should never be hit in this test file');
      },
    },
  },
};

const {
  hasVoucherForPackage,
  isEligibleForPackageVoucher,
  issuePackageVoucher,
  PACKAGE_AMOUNTS,
  UNUSED_VOUCHER_EXPIRY_MONTHS,
} = require('../../services/voucher');

// Small in-memory model of the two tables these functions touch (usertab, voucherstab).
// Any UPDATE/DELETE against voucherstab throws — that is how "grants are INSERT-only"
// gets falsified, not just asserted after the fact.
function makeConn({ account = null, vouchers = [] } = {}) {
  const calls = [];
  const state = { vouchers: vouchers.map((v) => ({ ...v })), nextId: 9000 };
  return {
    calls,
    state,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/UPDATE\s+voucherstab/i.test(sql) || /DELETE\s+FROM\s+voucherstab/i.test(sql)) {
        throw new Error(`FORBIDDEN mutation of voucherstab attempted: ${sql}`);
      }

      if (/INSERT\s+INTO\s+voucherstab/i.test(sql)) {
        const [uid, packageType, voucherAmount, remainingBalance] = params;
        const id = state.nextId++;
        state.vouchers.push({
          id,
          uid: Number(uid),
          package_type: Number(packageType),
          voucher_amount: Number(voucherAmount),
          remaining_balance: Number(remainingBalance),
          status: 1,
        });
        return [{ insertId: id }];
      }

      if (/SELECT\s+id\s+FROM\s+voucherstab/i.test(sql)) {
        const [uid, packageType] = params;
        const matches = state.vouchers.filter(
          (v) => v.uid === Number(uid) && v.package_type === Number(packageType)
        );
        return [matches.map((v) => ({ id: v.id }))];
      }

      if (/FROM\s+usertab/i.test(sql)) {
        return [account ? [account] : []];
      }

      return [[]];
    },
  };
}

// ── hasVoucherForPackage ──

test('hasVoucherForPackage: false when no voucherstab row for that uid+tier', async () => {
  const conn = makeConn({ vouchers: [{ id: 1, uid: 5, package_type: 10, status: 1, remaining_balance: 2500 }] });
  assert.strictEqual(await hasVoucherForPackage(conn, 5, 20), false);
});

test('hasVoucherForPackage: true regardless of status (1/2/3) and remaining_balance', async () => {
  const fullyUsedZeroBalance = makeConn({
    vouchers: [{ id: 1, uid: 5, package_type: 20, status: 3, remaining_balance: 0 }],
  });
  assert.strictEqual(await hasVoucherForPackage(fullyUsedZeroBalance, 5, 20), true);

  const expired = makeConn({
    vouchers: [{ id: 2, uid: 5, package_type: 20, status: 2, remaining_balance: 5000 }],
  });
  assert.strictEqual(await hasVoucherForPackage(expired, 5, 20), true);

  const active = makeConn({
    vouchers: [{ id: 3, uid: 5, package_type: 20, status: 1, remaining_balance: 5000 }],
  });
  assert.strictEqual(await hasVoucherForPackage(active, 5, 20), true);
});

// ── isEligibleForPackageVoucher ──

test('eligible when the member has NO voucher at all', async () => {
  const conn = makeConn({ account: { currentaccttype: 20, accttype: 10 }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 42);
  assert.deepStrictEqual(result, {
    eligible: true, reason: 'eligible', currentTier: 20, joinedTier: 10, amount: 5000,
  });
});

test('SeniorDelia case: joined Bronze(10), voucher fully used at 10, now Silver(20) -> eligible', async () => {
  const conn = makeConn({
    account: { currentaccttype: 20, accttype: 10 },
    vouchers: [{ id: 501, uid: 77, package_type: 10, status: 3, remaining_balance: 0 }],
  });
  const result = await isEligibleForPackageVoucher(conn, 77);
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.reason, 'eligible');
  assert.strictEqual(result.currentTier, 20);
  assert.strictEqual(result.amount, 5000);
});

test('NOT eligible when a voucher already exists at the CURRENT tier, status=3 fully used, remaining_balance=0', async () => {
  const conn = makeConn({
    account: { currentaccttype: 20, accttype: 10 },
    vouchers: [{ id: 9, uid: 3, package_type: 20, status: 3, remaining_balance: 0 }],
  });
  const result = await isEligibleForPackageVoucher(conn, 3);
  assert.deepStrictEqual(result, {
    eligible: false,
    reason: 'already_has_voucher_for_current_tier',
    currentTier: 20,
    joinedTier: 10,
    amount: 5000,
  });
});

test('NOT eligible when a voucher already exists at the current tier, status=1 active, remaining_balance>0', async () => {
  const conn = makeConn({
    account: { currentaccttype: 30, accttype: 20 },
    vouchers: [{ id: 10, uid: 4, package_type: 30, status: 1, remaining_balance: 10000 }],
  });
  const result = await isEligibleForPackageVoucher(conn, 4);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, 'already_has_voucher_for_current_tier');
});

test('NOT eligible for an unknown package type (not a PACKAGE_AMOUNTS key)', async () => {
  const conn = makeConn({ account: { currentaccttype: 99, accttype: 0 }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 6);
  assert.deepStrictEqual(result, {
    eligible: false, reason: 'unknown_package', currentTier: null, joinedTier: 0, amount: null,
  });
});

test('NOT eligible for a missing account (no usertab row)', async () => {
  const conn = makeConn({ account: null });
  const result = await isEligibleForPackageVoucher(conn, 7);
  assert.deepStrictEqual(result, {
    eligible: false, reason: 'account_not_found', currentTier: null, joinedTier: null, amount: null,
  });
});

test('currentaccttype takes precedence over accttype', async () => {
  const conn = makeConn({ account: { currentaccttype: 40, accttype: 10 }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 8);
  assert.strictEqual(result.currentTier, 40);
  assert.strictEqual(result.amount, 25000);
});

test('falls back to accttype when currentaccttype is 0', async () => {
  const conn = makeConn({ account: { currentaccttype: 0, accttype: 30 }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 9);
  assert.strictEqual(result.currentTier, 30);
});

test('falls back to accttype when currentaccttype is null', async () => {
  const conn = makeConn({ account: { currentaccttype: null, accttype: 50 }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 10);
  assert.strictEqual(result.currentTier, 50);
});

test('unknown_package when BOTH currentaccttype and accttype are 0/null (fail closed)', async () => {
  const conn = makeConn({ account: { currentaccttype: 0, accttype: null }, vouchers: [] });
  const result = await isEligibleForPackageVoucher(conn, 11);
  assert.deepStrictEqual(result, {
    eligible: false, reason: 'unknown_package', currentTier: null, joinedTier: 0, amount: null,
  });
});

// ── isEligibleForPackageVoucher requires conn (no default -> pool fallback) ──

test('isEligibleForPackageVoucher throws (does not silently use the pool) when called without a conn', async () => {
  await assert.rejects(() => isEligibleForPackageVoucher(undefined, 1));
});

// ── issuePackageVoucher ──

test('issuePackageVoucher inserts the correct amount and expiry for each of the six tiers', async () => {
  for (const [tierStr, amount] of Object.entries(PACKAGE_AMOUNTS)) {
    const tier = Number(tierStr);
    const conn = makeConn();
    const insertId = await issuePackageVoucher(conn, 123, tier);
    assert.strictEqual(typeof insertId, 'number');

    assert.strictEqual(conn.calls.length, 1);
    const call = conn.calls[0];
    assert.match(call.sql, /INSERT\s+INTO\s+voucherstab/i);
    const [uid, packageType, voucherAmount, remainingBalance, expiryMonths] = call.params;
    assert.strictEqual(uid, 123);
    assert.strictEqual(packageType, tier);
    assert.strictEqual(voucherAmount, amount);
    assert.strictEqual(remainingBalance, amount);
    assert.strictEqual(expiryMonths, UNUSED_VOUCHER_EXPIRY_MONTHS[tier]);
  }
});

test('issuePackageVoucher accepts packageType as a numeric-looking STRING (object key coercion)', async () => {
  const conn = makeConn();
  const insertId = await issuePackageVoucher(conn, 5, '20');
  assert.strictEqual(typeof insertId, 'number');
  const [, packageType, voucherAmount, remainingBalance, expiryMonths] = conn.calls[0].params;
  // packageType is passed through RAW (same as legacy issueVoucher) — MySQL coerces
  // the bound string to the INT column; Node-side lookups already resolved correctly.
  assert.strictEqual(packageType, '20');
  assert.strictEqual(voucherAmount, PACKAGE_AMOUNTS[20]);
  assert.strictEqual(remainingBalance, PACKAGE_AMOUNTS[20]);
  assert.strictEqual(expiryMonths, UNUSED_VOUCHER_EXPIRY_MONTHS[20]);
});

test('issuePackageVoucher returns null for an unrecognized package type, with no query executed', async () => {
  const conn = makeConn();
  const result = await issuePackageVoucher(conn, 123, 999);
  assert.strictEqual(result, null);
  assert.strictEqual(conn.calls.length, 0);
});

test('issuePackageVoucher works when called WITHOUT the options argument (no default-on-missing-name bug)', async () => {
  const conn = makeConn();
  const insertId = await issuePackageVoucher(conn, 5, 10);
  assert.strictEqual(typeof insertId, 'number');
});

test('issuePackageVoucher issues ONLY an INSERT — no UPDATE/DELETE against voucherstab', async () => {
  const conn = makeConn();
  await issuePackageVoucher(conn, 1, 10);
  assert.strictEqual(conn.calls.length, 1);
  for (const call of conn.calls) {
    assert.doesNotMatch(call.sql, /UPDATE\s+voucherstab/i);
    assert.doesNotMatch(call.sql, /DELETE\s+FROM\s+voucherstab/i);
  }
});

test('calling issuePackageVoucher twice does NOT modify the first row (additive, not replace)', async () => {
  const conn = makeConn();
  const firstId = await issuePackageVoucher(conn, 1, 10);
  const firstRowSnapshot = { ...conn.state.vouchers.find((v) => v.id === firstId) };

  const secondId = await issuePackageVoucher(conn, 1, 20);

  assert.notStrictEqual(firstId, secondId);
  assert.strictEqual(conn.state.vouchers.length, 2);
  assert.deepStrictEqual(conn.state.vouchers.find((v) => v.id === firstId), firstRowSnapshot);
  assert.strictEqual(conn.calls.length, 2);
  for (const call of conn.calls) {
    assert.match(call.sql, /INSERT\s+INTO\s+voucherstab/i);
  }
});

test('issuePackageVoucher throws (does not silently use the pool) when called without a conn', async () => {
  await assert.rejects(() => issuePackageVoucher(undefined, 1, 10));
});
