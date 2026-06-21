/**
 * READ-ONLY DRY-RUN: quantify the retroactive Sales Match Bonus (pairing / income2)
 * that REMOVING the Bronze/Silver lifetime pairing seal will credit on next recompute.
 *
 * Background: Bronze/Silver previously had a lifetime pairing seal (40,000 / 80,000)
 * AND a whole-income lifetime ceiling. Removing both means the pairing engine will,
 * the next time each affected member loads wallet/dashboard, compute a higher totalPay
 * and `calculateAndStoreIncome` will credit the delta via Math.max(0, totalPay - stored).
 *
 * This script computes that delta WITHOUT writing anything. It runs getPairing() with the
 * CURRENT (already-edited) policy and compares to stored payouttotaltab.ttlincome2.
 *
 *   delta = max(0, engineTotalPay_NEW - stored.ttlincome2)
 *
 * Only members whose stored SMB sits at/near the OLD seal can have been truncated, so by
 * default we scan Bronze/Silver members with stored ttlincome2 >= 90% of the old seal.
 * Use --all to scan every Bronze/Silver member (slow), --limit N to cap, --csv to dump rows.
 *
 * Usage:
 *   NODE_ENV=production node scripts/dryrun_cap_removal_impact.js [--all] [--limit=N] [--csv]
 *
 * READ-ONLY. No INSERT/UPDATE/DELETE. Safe to run on blue (prod) — it only reads.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

// Old lifetime pairing seals that were just removed (for filtering likely-affected rows).
const OLD_SEAL = { 10: 40000, 20: 80000 };

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = { all: false, limit: 0, csv: false };
  for (const a of args) {
    if (a === '--all') opt.all = true;
    else if (a === '--csv') opt.csv = true;
    else if (a.startsWith('--limit=')) opt.limit = Number(a.split('=')[1]) || 0;
  }
  return opt;
}

async function main() {
  const opt = parseArgs();
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[dryrun_cap_removal_impact] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log(`mode=${opt.all ? 'ALL Bronze/Silver' : 'near-seal only (>=90% of old seal)'} limit=${opt.limit || 'none'}\n`);

  const { pool } = require('../config/database');

  // Force the NEW Bronze/Silver caps in THIS process only (read-only sim), so the dry-run is
  // accurate even when run on blue — whose on-disk packagePolicy.js may still carry the old
  // 40k/80k seals. getPairing reads sealingPoint/ceiling at runtime via packagePolicy, so this
  // override makes getPairing compute the POST-deploy pairing total. It does NOT touch the live
  // nogatu-mlm process (this is a separate node invocation) and writes nothing.
  const policy = require('../services/packagePolicy');
  for (const t of [10, 20]) {
    if (policy.PACKAGE_POLICY_MAP[t]) {
      policy.PACKAGE_POLICY_MAP[t].lifetimeIncomeCeiling = 0;
      policy.PACKAGE_POLICY_MAP[t].sealingPoint = 0;
    }
  }
  console.log('[dry-run] forcing NEW caps in-process: Bronze/Silver sealingPoint=0, lifetimeIncomeCeiling=0');
  console.log('[dry-run] (read-only simulation — live app + on-disk policy untouched)\n');

  const { getPairing } = require('../services/income/pairing');

  // Candidate selection. currentaccttype is the live package (post-upgrade); the seal applied
  // to whatever package the member currently holds, so filter on currentaccttype 10/20.
  const where = opt.all
    ? `u.currentaccttype IN (10,20)`
    : `(
         (u.currentaccttype = 10 AND COALESCE(p.ttlincome2,0) >= ${OLD_SEAL[10] * 0.9})
      OR (u.currentaccttype = 20 AND COALESCE(p.ttlincome2,0) >= ${OLD_SEAL[20] * 0.9})
      )`;

  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype AS acct, m.username,
            COALESCE(p.ttlincome2,0) AS stored_smb
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      WHERE ${where}
      ORDER BY stored_smb DESC` + (opt.limit ? ` LIMIT ${opt.limit}` : ''),
  );

  console.log(`scanning ${rows.length} member(s)…\n`);

  const affected = [];
  let totalDelta = 0;
  let scanned = 0;
  for (const r of rows) {
    scanned += 1;
    // eslint-disable-next-line no-await-in-loop
    const res = await getPairing(Number(r.uid), Number(r.acct));
    const engine = Number(res.totalPay || 0);
    const stored = Number(r.stored_smb || 0);
    const delta = Math.max(0, engine - stored);
    if (delta >= 1) {
      affected.push({ uid: r.uid, username: r.username, acct: r.acct, stored, engine, delta });
      totalDelta += delta;
    }
    if (scanned % 50 === 0) process.stdout.write(`  …${scanned}/${rows.length}\r`);
  }

  affected.sort((a, b) => b.delta - a.delta);

  console.log(`\n=== CAP-REMOVAL IMPACT (retroactive SMB that WILL be credited on next recompute) ===`);
  console.log(`members scanned:           ${scanned}`);
  console.log(`members that will increase: ${affected.length}`);
  console.log(`TOTAL new SMB to credit:   ${totalDelta.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
  console.log(`(= ${(totalDelta / 250).toLocaleString('en-PH', { minimumFractionDigits: 2 })} PV)\n`);

  const top = affected.slice(0, 40);
  if (top.length) {
    console.log('top affected:');
    console.log('  acct  uid        username            stored_SMB ->  new_SMB     (+delta)');
    for (const a of top) {
      const label = a.acct === 10 ? 'Brz' : 'Slv';
      console.log(
        `  ${label}  ${String(a.uid).padEnd(9)} ${String(a.username).slice(0, 18).padEnd(18)} ` +
        `${a.stored.toFixed(2).padStart(11)} -> ${a.engine.toFixed(2).padStart(11)}  (+${a.delta.toFixed(2)})`
      );
    }
  } else {
    console.log('No members increase — removing the seal credits nobody (all were below the old seal).');
  }

  if (opt.csv && affected.length) {
    console.log('\n--- CSV (uid,username,acct,stored_smb,new_smb,delta) ---');
    for (const a of affected) {
      console.log(`${a.uid},${a.username},${a.acct},${a.stored},${a.engine},${a.delta}`);
    }
  }

  console.log('\nNOTE: read-only — nothing was written. These deltas only post when each member');
  console.log('next loads wallet/dashboard (or via a rebuild). Review before deploying caps to blue.\n');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
