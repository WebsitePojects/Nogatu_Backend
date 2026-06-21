/**
 * READ-ONLY DRY-RUN: complete impact of removing the Bronze/Silver lifetime gates.
 *
 * Two gates were removed (both 40,000 Bronze / 80,000 Silver):
 *   1. sealingPoint          — caps LIFETIME PAIRING (income type 2) only.
 *   2. lifetimeIncomeCeiling — caps TOTAL income (types 1..6); once total stored income
 *                              reaches the ceiling, ALL further income is blocked.
 *
 * On the next wallet/dashboard load after deploy, calculateAndStoreIncome recomputes the
 * continuous income types and credits the positive delta via Math.max(0, full - stored):
 *   dDref = max(0, getDREF - ttlincome1)
 *   dPair = max(0, getPairing(newCaps) - ttlincome2)
 *   dLead = max(0, getLeadershipBonus - ttlincome3)
 * Under the OLD gates these deltas were (partly) blocked; under the new caps they post in full.
 * This script sums them per member WITHOUT writing anything = the exact retroactive exposure.
 *
 * (Unilevel/hifive excluded: unilevel is monthly-guarded so it does not retro-credit past
 * months; hifive is release-controlled and not auto-credited by the shared calculator.)
 *
 * Candidates: Bronze/Silver members whose stored PAIRING is near the old seal OR whose stored
 * TOTAL income is near the old ceiling (>=90%). Members below both were never truncated by the
 * gates, so removing them changes nothing. Use --all to scan every Bronze/Silver (slow).
 *
 * Usage:  NODE_ENV=production node scripts/dryrun_cap_removal_impact.js [--all] [--limit=N] [--csv]
 * READ-ONLY. No writes. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const OLD_SEAL = { 10: 40000, 20: 80000 };
const OLD_CEILING = { 10: 40000, 20: 80000 };

function parseArgs() {
  const opt = { all: false, limit: 0, csv: false };
  for (const a of process.argv.slice(2)) {
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
  console.log(`mode=${opt.all ? 'ALL Bronze/Silver' : 'near seal OR ceiling (>=90%)'} limit=${opt.limit || 'none'}\n`);

  const { pool } = require('../config/database');

  // Force NEW caps in THIS process only (read-only sim). Accurate even on blue, whose on-disk
  // packagePolicy.js may still carry the old seals. Does NOT touch the live nogatu-mlm process.
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
  const { getDREF } = require('../services/income/directReferral');
  const { getLeadershipBonus } = require('../services/income/leadership');

  const where = opt.all
    ? `u.currentaccttype IN (10,20)`
    : `(
         (u.currentaccttype = 10 AND (
            COALESCE(p.ttlincome2,0) >= ${OLD_SEAL[10] * 0.9}
         OR (COALESCE(p.ttlincome1,0)+COALESCE(p.ttlincome2,0)+COALESCE(p.ttlincome3,0)
            +COALESCE(p.ttlincome4,0)+COALESCE(p.ttlincome5,0)+COALESCE(p.ttlincome6,0)) >= ${OLD_CEILING[10] * 0.9}))
      OR (u.currentaccttype = 20 AND (
            COALESCE(p.ttlincome2,0) >= ${OLD_SEAL[20] * 0.9}
         OR (COALESCE(p.ttlincome1,0)+COALESCE(p.ttlincome2,0)+COALESCE(p.ttlincome3,0)
            +COALESCE(p.ttlincome4,0)+COALESCE(p.ttlincome5,0)+COALESCE(p.ttlincome6,0)) >= ${OLD_CEILING[20] * 0.9}))
      )`;

  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype AS acct, m.username,
            COALESCE(p.ttlincome1,0) AS i1, COALESCE(p.ttlincome2,0) AS i2, COALESCE(p.ttlincome3,0) AS i3,
            (COALESCE(p.ttlincome1,0)+COALESCE(p.ttlincome2,0)+COALESCE(p.ttlincome3,0)
            +COALESCE(p.ttlincome4,0)+COALESCE(p.ttlincome5,0)+COALESCE(p.ttlincome6,0)) AS total_income
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      WHERE ${where}
      ORDER BY total_income DESC` + (opt.limit ? ` LIMIT ${opt.limit}` : ''),
  );

  console.log(`scanning ${rows.length} candidate member(s)…\n`);

  const affected = [];
  let totDref = 0, totPair = 0, totLead = 0;
  let scanned = 0;
  for (const r of rows) {
    scanned += 1;
    const uid = Number(r.uid);
    // eslint-disable-next-line no-await-in-loop
    const [dref, pair, lead] = await Promise.all([
      getDREF(uid).then((x) => Number(x?.directreferral || 0)).catch(() => 0),
      getPairing(uid, Number(r.acct)).then((x) => Number(x?.totalPay || 0)).catch(() => 0),
      getLeadershipBonus(uid).then((x) => Number(x || 0)).catch(() => 0),
    ]);
    const dDref = Math.max(0, dref - Number(r.i1));
    const dPair = Math.max(0, pair - Number(r.i2));
    const dLead = Math.max(0, lead - Number(r.i3));
    const retro = dDref + dPair + dLead;
    if (retro >= 1) {
      affected.push({ uid, username: r.username, acct: r.acct, dDref, dPair, dLead, retro,
        total: Number(r.total_income) });
      totDref += dDref; totPair += dPair; totLead += dLead;
    }
    if (scanned % 50 === 0) process.stdout.write(`  …${scanned}/${rows.length}\r`);
  }

  affected.sort((a, b) => b.retro - a.retro);
  const grand = totDref + totPair + totLead;

  console.log(`\n=== COMPLETE CAP-REMOVAL IMPACT (retroactive income that WILL post on next recompute) ===`);
  console.log(`candidates scanned:          ${scanned}`);
  console.log(`members that will increase:  ${affected.length}`);
  console.log(`  direct referral (type 1):  ${totDref.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
  console.log(`  pairing / SMB   (type 2):  ${totPair.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
  console.log(`  leadership      (type 3):  ${totLead.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
  console.log(`  TOTAL new income to credit: ${grand.toLocaleString('en-PH', { minimumFractionDigits: 2 })}\n`);

  for (const a of affected.slice(0, 40)) {
    const label = a.acct === 10 ? 'Brz' : 'Slv';
    console.log(`  ${label} ${String(a.uid).padEnd(9)} ${String(a.username).slice(0, 18).padEnd(18)} ` +
      `dref+${a.dDref.toFixed(2)} pair+${a.dPair.toFixed(2)} lead+${a.dLead.toFixed(2)} = +${a.retro.toFixed(2)} ` +
      `(stored total ${a.total.toFixed(2)})`);
  }
  if (!affected.length) {
    console.log('No members increase — both gates were already non-binding; cap removal credits nobody.');
  }

  if (opt.csv && affected.length) {
    console.log('\n--- CSV (uid,username,acct,dDref,dPair,dLead,retro) ---');
    for (const a of affected) console.log(`${a.uid},${a.username},${a.acct},${a.dDref},${a.dPair},${a.dLead},${a.retro}`);
  }

  console.log('\nNOTE: read-only — nothing written. Deltas post when each member next loads wallet/dashboard.');
  console.log('Review this total before deploying caps to blue.\n');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
