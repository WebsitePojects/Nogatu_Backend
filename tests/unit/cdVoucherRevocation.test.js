const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readCandidates,
  applyManifest,
  hashManifest,
  assertExpectedHash,
  assertProductionConfirmation,
} = require('../../scripts/cdVoucherRevocation');

function makeCandidateConnection({ rows, upgrades = {} }) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM voucherstab v INNER JOIN usertab u')) return [rows];
      if (sql.includes('FROM upgradetab u')) {
        const uid = Number(params[0]);
        return [upgrades[uid] ? [{ codetype: upgrades[uid], productamount: 10000 }] : []];
      }
      throw new Error(`Unhandled SQL in candidate test: ${sql}`);
    },
  };
}

const baseVoucher = {
  voucherId: 1,
  uid: 10,
  packageType: 30,
  remainingBalance: 99,
  status: 1,
  accttype: 30,
  currentaccttype: 30,
  codeid: 3,
  cdamount: 10000,
  cdtotal: 0,
  cdstatus: 1,
};

test('readCandidates includes raw CD and PD upgraded to CD vouchers only', async () => {
  const conn = makeCandidateConnection({
    rows: [
      { ...baseVoucher, voucherId: 1, uid: 10, codeid: 3 },
      { ...baseVoucher, voucherId: 2, uid: 20, codeid: 1 },
      { ...baseVoucher, voucherId: 3, uid: 30, codeid: 2 },
      { ...baseVoucher, voucherId: 4, uid: 40, codeid: 1, accttype: 10, currentaccttype: 30 },
    ],
    upgrades: { 40: 3 },
  });

  const candidates = await readCandidates(conn);

  assert.deepEqual(candidates.map((row) => row.voucherId), [1, 4]);
});

test('readCandidates excludes raw CD accounts upgraded to PD or FS', async () => {
  const conn = makeCandidateConnection({
    rows: [
      { ...baseVoucher, voucherId: 1, uid: 10, codeid: 3, accttype: 10, currentaccttype: 30 },
      { ...baseVoucher, voucherId: 2, uid: 20, codeid: 3, accttype: 10, currentaccttype: 30 },
    ],
    upgrades: { 10: 1, 20: 2 },
  });

  assert.deepEqual(await readCandidates(conn), []);
});

test('readCandidates fails closed when upgraded account state is unknown', async () => {
  const conn = makeCandidateConnection({
    rows: [{ ...baseVoucher, voucherId: 1, uid: 10, codeid: 3, accttype: 10, currentaccttype: 30 }],
  });

  await assert.rejects(() => readCandidates(conn), /Unknown effective account state/);
});

function makeApplyConnection(options = {}) {
  const voucher = {
    id: 7,
    uid: 10,
    package_type: 30,
    remaining_balance: 99,
    status: options.voucherStatus ?? 1,
  };
  const account = {
    uid: 10,
    accttype: options.accttype ?? 30,
    currentaccttype: options.currentaccttype ?? 30,
    codeid: options.codeid ?? 3,
    cdamount: 10000,
    cdtotal: 0,
    cdstatus: 1,
  };
  const audits = options.audits ? [...options.audits] : [];
  const calls = [];
  return {
    audits,
    calls,
    voucher,
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/payout|wallet|cash/i.test(sql)) {
        throw new Error(`Wallet/cash query is forbidden in revocation test: ${sql}`);
      }
      if (sql.includes('SELECT uid, accttype')) return [[account]];
      if (sql.includes('FROM upgradetab up')) {
        return [options.upgradeCodeType ? [{ codetype: options.upgradeCodeType }] : []];
      }
      if (sql.includes('FROM upgradetab u')) {
        return [options.upgradeCodeType ? [{ codetype: options.upgradeCodeType, productamount: 10000 }] : []];
      }
      if (sql.includes('SELECT id, uid, package_type')) return [[voucher]];
      if (sql.includes('SELECT id FROM voucher_revocation_audittab')) {
        return [audits.filter((row) => row.manifest_hash === params[0] && row.voucher_id === params[1])];
      }
      if (sql.startsWith('UPDATE voucherstab')) {
        if (voucher.status === 5) return [{ affectedRows: 0 }];
        voucher.status = 5;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO voucher_revocation_audittab')) {
        audits.push({ manifest_hash: params[1], voucher_id: params[2] });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unhandled SQL in apply test: ${sql}`);
    },
  };
}

test('apply refuses a stale manifest when voucher status changed', async () => {
  const conn = makeApplyConnection({ voucherStatus: 4 });
  const manifest = [{ voucherId: 7, uid: 10, packageType: 30, remainingBalance: 99, status: 1 }];

  await assert.rejects(
    () => applyManifest(conn, manifest, hashManifest(manifest)),
    /manifest status changed/
  );
  assert.equal(conn.voucher.status, 4);
});

test('apply refuses a stale manifest when account is no longer CD', async () => {
  const conn = makeApplyConnection({ codeid: 1 });
  const manifest = [{ voucherId: 7, uid: 10, packageType: 30, remainingBalance: 99, status: 1 }];

  await assert.rejects(
    () => applyManifest(conn, manifest, hashManifest(manifest)),
    /Effective account state changed/
  );
  assert.equal(conn.voucher.status, 1);
});

test('apply is resumable and does not duplicate revocation audit or touch wallet state', async () => {
  const conn = makeApplyConnection();
  const manifest = [{ voucherId: 7, uid: 10, packageType: 30, remainingBalance: 99, status: 1 }];
  const hash = hashManifest(manifest);

  const first = await applyManifest(conn, manifest, hash);
  const second = await applyManifest(conn, manifest, hash);

  assert.equal(first.revoked, 1);
  assert.equal(second.revoked, 0);
  assert.equal(conn.audits.length, 1);
  assert.equal(conn.voucher.status, 5);
});

test('apply refuses an already revoked voucher without matching manifest audit', async () => {
  const conn = makeApplyConnection({ voucherStatus: 5 });
  const manifest = [{ voucherId: 7, uid: 10, packageType: 30, remainingBalance: 99, status: 1 }];

  await assert.rejects(
    () => applyManifest(conn, manifest, hashManifest(manifest)),
    /already revoked without this run manifest audit/
  );
});

test('expected hash is required for apply', () => {
  const manifest = [{ voucherId: 7, uid: 10, packageType: 30, remainingBalance: 99, status: 1 }];
  const hash = hashManifest(manifest);

  assert.throws(() => assertExpectedHash(hash, null), /expected-hash is required/);
  assert.throws(() => assertExpectedHash(hash, 'a'.repeat(64)), /does not match/);
  assert.doesNotThrow(() => assertExpectedHash(hash, hash));
});

test('production apply requires the explicit production confirmation token', () => {
  const originalArgv = process.argv;
  try {
    process.argv = ['node', 'script', '--apply'];
    assert.throws(() => assertProductionConfirmation('nogatualliance_sysdb'), /Production apply requires/);

    process.argv = ['node', 'script', '--apply', '--confirm', 'APPLY-CD-VOUCHER-REVOCATION'];
    assert.doesNotThrow(() => assertProductionConfirmation('nogatualliance_sysdb'));
  } finally {
    process.argv = originalArgv;
  }
});
