/**
 * READ-ONLY audit: binary-points integrity across ALL members. No writes.
 *
 * Concern #6 ("binary points are missing"). Flags:
 *   A) usertab.binarypoints = 0/null  — member contributes nothing to uplines.
 *       Highlights PAID (codeid=1) accounts separately, since a paid account with
 *       0 binary points is the real red flag (FS / unpaid-CD legitimately = 0).
 *   B) binarypoints != current-package binaryValue — value was frozen at the
 *       registration package and never re-stamped on upgrade. Split by whether an
 *       upgradetab(transtype=1) row exists (the delta may have been credited there
 *       as a separate binary event) vs an unexplained mismatch.
 *
 * Usage (prod, read-only):  NODE_ENV=production node scripts/audit_binary_points.js
 * This script only SELECTs. It never writes.
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const { getPackageBinaryValue } = require('../services/packagePolicy');

const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const conn = await mysql.createConnection(cfg);
  console.log(`\n[audit_binary_points] READ-ONLY · env=${envFile} db=${cfg.database}@${cfg.host}\n`);

  const [rows] = await conn.query(
    `SELECT u.uid, m.username, u.codeid, u.cdstatus, u.currentaccttype, u.accttype,
            COALESCE(u.binarypoints, 0) AS binarypoints,
            COALESCE(up.cnt, 0) AS upgrades
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN (SELECT uid, COUNT(*) cnt FROM upgradetab WHERE transtype = 1 GROUP BY uid) up
         ON up.uid = u.uid`
  );

  const total = rows.length;
  const zero = [];
  const zeroPaid = [];
  const mismatch = [];
  for (const r of rows) {
    const bp = Number(r.binarypoints || 0);
    const expected = getPackageBinaryValue(r.currentaccttype);
    if (bp === 0) {
      zero.push(r);
      if (Number(r.codeid) === 1) zeroPaid.push(r);
      continue;
    }
    if (expected > 0 && bp !== expected) mismatch.push({ ...r, expected });
  }
  const mismatchUpgraded = mismatch.filter((r) => Number(r.upgrades) > 0);
  const mismatchNoUpgrade = mismatch.filter((r) => Number(r.upgrades) === 0);

  console.log(`Total members:                                  ${total}`);
  console.log(`A) binary points = 0/null (any type):           ${zero.length}`);
  console.log(`   of which PAID (codeid=1) — RED FLAG:          ${zeroPaid.length}`);
  console.log(`B) binary points != current-package value:      ${mismatch.length}`);
  console.log(`   - WITH upgradetab rows (delta likely in upgradetab): ${mismatchUpgraded.length}`);
  console.log(`   - WITHOUT upgrade rows (unexplained):                ${mismatchNoUpgrade.length}\n`);

  const sample = (label, arr) => {
    if (!arr.length) return;
    console.log(`--- ${label} (showing up to 30 of ${arr.length}) ---`);
    for (const r of arr.slice(0, 30)) {
      const exp = r.expected != null ? ` expected=${r.expected}` : '';
      console.log(`  uid=${r.uid} @${r.username} code=${CODE_LABEL[r.codeid] || r.codeid} cd=${r.cdstatus}`
        + ` acct=${r.currentaccttype} bp=${r.binarypoints}${exp} upgrades=${r.upgrades}`);
    }
    console.log('');
  };
  sample('A) PAID accounts with ZERO binary points (investigate first)', zeroPaid);
  sample('B1) mismatch WITHOUT upgrade rows (investigate)', mismatchNoUpgrade);
  sample('B2) mismatch WITH upgrade rows (verify upgradetab credited the delta)', mismatchUpgraded);

  console.log('NOTE: this audit reports only. It changes nothing. Confirm any flagged');
  console.log('member with a per-account trace before considering a money correction.\n');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
