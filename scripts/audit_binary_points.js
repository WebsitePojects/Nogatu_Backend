/**
 * READ-ONLY audit: binary-points integrity across ALL members. No writes.
 *
 * Concern #6 ("binary points are missing"). The pairing engine
 * (services/income/pairing.js) credits a member's binary contribution as
 *     usertab.binarypoints (base package, set at registration)
 *   + Σ upgradetab.binarypoints WHERE transtype=1 (each upgrade, fresh event)
 * So usertab.binarypoints alone being below the current package is EXPECTED for
 * upgraded members — the delta lives in upgradetab.
 *
 * This audit computes the EFFECTIVE contribution (base + upgrade events) and
 * compares it to the current package's binaryValue, classifying each member:
 *   MATCH  — effective == package value (correct)
 *   UNDER  — effective <  package value (upline under-credited)  ← real concern
 *   OVER   — effective >  package value (upline over-credited)
 *   ZERO   — effective 0 on a PAID account (contributes nothing) ← red flag
 * FS / unpaid-CD are not pairing sources, so their values are informational.
 *
 * Usage (prod, read-only):  NODE_ENV=production node scripts/audit_binary_points.js
 * This script only SELECTs. It never writes.
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const { getPackageBinaryValue } = require('../services/packagePolicy');

const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };
const isPaidSource = (r) => Number(r.codeid) === 1 || (Number(r.codeid) === 3 && Number(r.cdstatus) === 2);

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const conn = await mysql.createConnection(cfg);
  console.log(`\n[audit_binary_points] READ-ONLY · env=${envFile} db=${cfg.database}@${cfg.host}\n`);

  const [rows] = await conn.query(
    `SELECT u.uid, m.username, u.codeid, u.cdstatus, u.currentaccttype,
            COALESCE(u.binarypoints, 0)      AS base_pts,
            COALESCE(up.cnt, 0)              AS upgrades,
            COALESCE(up.pts, 0)              AS upgrade_pts
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN (
         SELECT uid, COUNT(*) cnt, COALESCE(SUM(binarypoints),0) pts
           FROM upgradetab WHERE transtype = 1 GROUP BY uid
       ) up ON up.uid = u.uid`
  );

  const buckets = { MATCH: [], UNDER: [], OVER: [], ZERO_PAID: [], UNRANKED_PKG: [] };
  for (const r of rows) {
    const expected = getPackageBinaryValue(r.currentaccttype);
    const effective = Number(r.base_pts) + Number(r.upgrade_pts);
    const rec = { ...r, expected, effective };
    if (expected <= 0) { buckets.UNRANKED_PKG.push(rec); continue; }
    if (effective === 0) { if (isPaidSource(r)) buckets.ZERO_PAID.push(rec); continue; }
    if (effective === expected) buckets.MATCH.push(rec);
    else if (effective < expected) buckets.UNDER.push(rec);
    else buckets.OVER.push(rec);
  }

  const upgradedUnder = buckets.UNDER.filter((r) => Number(r.upgrades) > 0).length;
  const baseUnderNoUpg = buckets.UNDER.filter((r) => Number(r.upgrades) === 0).length;

  console.log(`Total members:                                   ${rows.length}`);
  console.log(`MATCH  (effective == package value):             ${buckets.MATCH.length}`);
  console.log(`UNDER  (effective < package — under-credit):     ${buckets.UNDER.length}`);
  console.log(`         · upgraded (delta short in upgradetab): ${upgradedUnder}`);
  console.log(`         · no upgrade (base short at register):  ${baseUnderNoUpg}`);
  console.log(`OVER   (effective > package — over-credit):      ${buckets.OVER.length}`);
  console.log(`ZERO   (paid source contributing 0):             ${buckets.ZERO_PAID.length}`);
  console.log(`(pkg has no binary value — informational:        ${buckets.UNRANKED_PKG.length})\n`);

  const sample = (label, arr) => {
    if (!arr.length) return;
    console.log(`--- ${label} (showing up to 30 of ${arr.length}) ---`);
    for (const r of arr.slice(0, 30)) {
      console.log(`  uid=${r.uid} @${r.username} code=${CODE_LABEL[r.codeid] || r.codeid} cd=${r.cdstatus}`
        + ` acct=${r.currentaccttype} base=${r.base_pts} +upg=${r.upgrade_pts}(${r.upgrades})`
        + ` = effective=${r.effective} vs package=${r.expected}`);
    }
    console.log('');
  };
  sample('UNDER — upline under-credited (investigate; real concern)', buckets.UNDER);
  sample('OVER — upline over-credited (investigate)', buckets.OVER);
  sample('ZERO paid source', buckets.ZERO_PAID);

  console.log('NOTE: read-only. UNDER/OVER mean the engine sums base+upgrade to a value');
  console.log('different from the current package — confirm intended upgrade model with a');
  console.log('per-account trace before any money change.\n');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
