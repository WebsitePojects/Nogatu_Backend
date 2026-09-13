#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const { resolveVoucherAccountPolicy } = require('../services/cdVoucherPolicy');

const PRODUCTION_DB = 'nogatualliance_sysdb';
const PRODUCTION_CONFIRM = 'APPLY-CD-VOUCHER-REVOCATION';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function has(name) {
  return process.argv.includes(name);
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function assertSafeInteger(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid manifest ${field}`);
  return n;
}

function assertSafeStatus(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error(`Invalid manifest ${field}`);
  return n;
}

function assertSafeMoney(value, field) {
  const n = money(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid manifest ${field}`);
  return n;
}

function canonical(rows) {
  return rows
    .map((row) => ({
      voucherId: assertSafeInteger(row.voucherId, 'voucherId'),
      uid: assertSafeInteger(row.uid, 'uid'),
      packageType: assertSafeInteger(row.packageType, 'packageType'),
      remainingBalance: assertSafeMoney(row.remainingBalance, 'remainingBalance'),
      status: assertSafeStatus(row.status, 'status'),
    }))
    .sort((a, b) => a.voucherId - b.voucherId);
}

function hashManifest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
}

function parseManifest(file) {
  if (!file) throw new Error('--manifest is required for apply');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Manifest must contain a non-empty rows array');
  }

  const result = canonical(rows);
  if (!Array.isArray(parsed) && parsed.manifestHash && parsed.manifestHash !== hashManifest(result)) {
    throw new Error('Manifest hash does not match manifest rows');
  }
  return result;
}

function assertExpectedHash(actualHash, expectedHash) {
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(String(expectedHash))) {
    throw new Error('--expected-hash is required and must be a 64-character SHA-256 hash');
  }
  if (String(actualHash).toLowerCase() !== String(expectedHash).toLowerCase()) {
    throw new Error('Manifest hash does not match --expected-hash');
  }
}

async function readCandidates(conn) {
  const [rows] = await conn.query(
    'SELECT v.id AS voucherId, v.uid, v.package_type AS packageType, v.remaining_balance AS remainingBalance, v.status, ' +
      'u.codeid, u.accttype, u.currentaccttype, u.cdamount, u.cdtotal, u.cdstatus ' +
      'FROM voucherstab v INNER JOIN usertab u ON u.uid = v.uid WHERE v.status <> 5'
  );

  const candidates = [];
  for (const row of rows) {
    const policy = await resolveVoucherAccountPolicy(conn, row.uid, row);
    if (!policy.known) {
      throw new Error('Unknown effective account state; refusing CD voucher revocation');
    }
    if (policy.effectiveCodeType !== 'CD') continue;

    candidates.push({
      voucherId: Number(row.voucherId),
      uid: Number(row.uid),
      packageType: Number(row.packageType),
      remainingBalance: money(row.remainingBalance),
      status: Number(row.status),
    });
  }

  return canonical(candidates);
}

function assertExpected(rows, expectedCount, expectedRemaining) {
  if (expectedCount == null) {
    throw new Error('--expected-count is required');
  }
  if (rows.length !== Number(expectedCount)) {
    throw new Error('Candidate count does not match --expected-count');
  }
  if (expectedRemaining != null) {
    const total = money(rows.reduce((sum, row) => sum + Number(row.remainingBalance || 0), 0));
    if (total !== money(expectedRemaining)) {
      throw new Error('Candidate remaining total does not match --expected-remaining');
    }
  }
}

function assertManifestScope(activeCandidates, manifest) {
  const allowed = new Set(manifest.map((row) => row.voucherId));
  const outside = activeCandidates.find((row) => !allowed.has(row.voucherId));
  if (outside) {
    throw new Error('Current CD voucher candidates include a row outside the supplied manifest');
  }
}

function assertProductionConfirmation(dbName) {
  if (dbName !== PRODUCTION_DB || !has('--apply')) return;
  if (arg('--confirm') !== PRODUCTION_CONFIRM) {
    throw new Error(`Production apply requires --confirm=${PRODUCTION_CONFIRM}`);
  }
}

async function applyManifest(conn, manifest, manifestHashValue) {
  const runId = crypto.randomUUID();
  let revoked = 0;

  for (const item of manifest) {
    await conn.beginTransaction();
    try {
      const [accountRows] = await conn.query(
        'SELECT uid, accttype, currentaccttype, codeid, cdamount, cdtotal, cdstatus FROM usertab WHERE uid = ? LIMIT 1 FOR UPDATE',
        [item.uid]
      );
      if (!accountRows.length) throw new Error('Account disappeared during revocation');

      const [upgradeRows] = await conn.query(
        'SELECT c.codetype FROM upgradetab up INNER JOIN codestab c ON c.id = up.codeid WHERE up.uid = ? AND up.transtype = 1 ORDER BY up.transdate DESC, up.id DESC LIMIT 1',
        [item.uid]
      );

      const account = accountRows[0];
      const policy = await resolveVoucherAccountPolicy(conn, item.uid, {
        ...account,
        upgrade_codetype: upgradeRows[0]?.codetype ?? 0,
      });
      if (!policy.known || policy.effectiveCodeType !== 'CD') {
        throw new Error('Effective account state changed or is unknown; refusing stale manifest row');
      }

      const [voucherRows] = await conn.query(
        'SELECT id, uid, package_type, remaining_balance, status FROM voucherstab WHERE id = ? AND uid = ? LIMIT 1 FOR UPDATE',
        [item.voucherId, item.uid]
      );
      if (!voucherRows.length) throw new Error('Voucher disappeared during revocation');

      const voucher = voucherRows[0];
      if (
        Number(voucher.package_type) !== item.packageType
        || money(voucher.remaining_balance) !== money(item.remainingBalance)
      ) {
        throw new Error('Voucher manifest row changed');
      }

      if (Number(voucher.status) === 5) {
        const [auditRows] = await conn.query(
          'SELECT id FROM voucher_revocation_audittab WHERE manifest_hash = ? AND voucher_id = ? LIMIT 1',
          [manifestHashValue, item.voucherId]
        );
        if (!auditRows.length) {
          throw new Error('Voucher is already revoked without this run manifest audit');
        }
      } else if (Number(voucher.status) !== item.status) {
        throw new Error('Voucher manifest status changed');
      } else {
        const [update] = await conn.query(
          'UPDATE voucherstab SET status = 5, revoked_at = NOW(), revocation_reason = ?, revoked_by = ? WHERE id = ? AND status <> 5',
          ['CD voucher policy correction', `cd-voucher-revocation:${manifestHashValue}`, item.voucherId]
        );
        if (Number(update.affectedRows) !== 1) throw new Error('Voucher revocation CAS lost');

        await conn.query(
          'INSERT INTO voucher_revocation_audittab (run_id, manifest_hash, voucher_id, uid, package_type, remaining_balance, voucher_status_before, effective_code_type, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [runId, manifestHashValue, item.voucherId, item.uid, item.packageType, item.remainingBalance, voucher.status, 'CD', 'CD voucher policy correction']
        );
        revoked += 1;
      }

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  }

  return { runId, revoked };
}

async function main() {
  const envFile = loadBackendEnv();
  const dbConfig = getDbConfig();
  const expectedDb = arg('--expected-db');
  if (!expectedDb || dbConfig.database !== expectedDb) {
    throw new Error('Refusing to run: provide matching --expected-db');
  }
  assertProductionConfirmation(dbConfig.database);

  const conn = await mysql.createConnection(dbConfig);
  try {
    const candidates = await readCandidates(conn);
    const expectedCount = arg('--expected-count');
    const expectedRemaining = arg('--expected-remaining');
    const currentHash = hashManifest(candidates);

    if (!has('--apply')) {
      assertExpected(candidates, expectedCount, expectedRemaining);
      console.log(JSON.stringify({
        mode: 'dry-run',
        env: envFile,
        database: dbConfig.database,
        candidateCount: candidates.length,
        remainingTotal: money(candidates.reduce((sum, row) => sum + row.remainingBalance, 0)),
        manifestHash: currentHash,
      }));
      if (has('--write-manifest')) {
        fs.writeFileSync(arg('--write-manifest'), JSON.stringify({ rows: candidates, manifestHash: currentHash }, null, 2) + '\n', { flag: 'wx' });
      }
      return;
    }

    const manifest = parseManifest(arg('--manifest'));
    assertExpected(manifest, expectedCount, expectedRemaining);
    assertManifestScope(candidates, manifest);
    const manifestHashValue = hashManifest(manifest);
    assertExpectedHash(manifestHashValue, arg('--expected-hash'));
    const result = await applyManifest(conn, manifest, manifestHashValue);
    console.log(JSON.stringify({
      mode: 'apply',
      env: envFile,
      database: dbConfig.database,
      runId: result.runId,
      manifestHash: manifestHashValue,
      candidateCount: manifest.length,
      revoked: result.revoked,
    }));
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[cdVoucherRevocation] failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  canonical,
  hashManifest,
  assertExpectedHash,
  readCandidates,
  assertExpected,
  assertManifestScope,
  assertProductionConfirmation,
  applyManifest,
};
