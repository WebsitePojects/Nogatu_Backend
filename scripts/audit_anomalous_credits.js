/**
 * READ-ONLY COMPREHENSIVE ANOMALOUS-CREDIT DETECTOR.
 *
 * For each income type with a CLEAN, recomputable entitlement formula, flag every member
 * whose STORED total exceeds what the engine entitlement currently justifies:
 *
 *   type 1  Direct Referral  stored ttlincome1  vs getDREF()            -> overpay if stored > engine
 *   type 3  Leadership        stored ttlincome3  vs getLeadershipBonus()-> overpay if stored > engine
 *   type 5  Hi-Five           stored ttlincome5  vs hifive entitlement  -> overpay if stored > engine
 *
 * NOT flagged here (by design):
 *   type 2  Pairing/SMB  — ttlincome2 is the AUTHORITATIVE monotonic total (legacy-heavy); the
 *           engine can only ever RAISE it (Math.max), so stored >= engine is expected, not anomalous.
 *   type 4  Unilevel — monthly/guarded; needs a month-by-month audit, not a single snapshot.
 *   type 6  Ranking — admin-released against rank achievements; audit separately vs rank_achievementstab.
 *
 * ⚠️ A flag means stored > CURRENT entitlement. That is an INVESTIGATION CANDIDATE, not proof of
 *    fraud: it can be a genuine mispay OR a legitimate historical payment whose qualifying downline
 *    later shrank. The auto-credit never causes these (it is monotonic max(0, entitlement-paid)).
 *
 * Usage:  NODE_ENV=production node scripts/audit_anomalous_credits.js [--limit=N] [--csv] [--type=1,3,5]
 * READ-ONLY. No writes. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const TOL = 1; // peso tolerance to ignore rounding noise

function parseArgs() {
  const opt = { limit: 0, csv: false, types: new Set(['1', '3', '5']) };
  for (const a of process.argv.slice(2)) {
    if (a === '--csv') opt.csv = true;
    else if (a.startsWith('--limit=')) opt.limit = Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--type=')) opt.types = new Set(a.split('=')[1].split(','));
  }
  return opt;
}

async function main() {
  const opt = parseArgs();
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_anomalous_credits] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log(`checking income types: ${[...opt.types].sort().join(', ')} (1=DR, 3=Leadership, 5=HiFive)\n`);

  const { pool } = require('../config/database');
  const { getDREF } = require('../services/income/directReferral');
  const { getLeadershipBonus } = require('../services/income/leadership');
  const { buildHiFiveStatus } = require('../services/income/hifiveBonus');

  const [rows] = await pool.query(
    `SELECT p.uid, m.username,
            COALESCE(p.ttlincome1,0) AS i1, COALESCE(p.ttlincome3,0) AS i3, COALESCE(p.ttlincome5,0) AS i5
       FROM payouttotaltab p LEFT JOIN memberstab m ON m.uid = p.uid
      WHERE COALESCE(p.ttlincome1,0) > 0 OR COALESCE(p.ttlincome3,0) > 0 OR COALESCE(p.ttlincome5,0) > 0
      ORDER BY p.uid` + (opt.limit ? ` LIMIT ${opt.limit}` : '')
  );
  console.log(`members with stored income to check: ${rows.length}\n`);

  const flagged = { 1: [], 3: [], 5: [] };
  let scanned = 0;
  for (const r of rows) {
    scanned += 1;
    const uid = Number(r.uid);

    if (opt.types.has('1') && Number(r.i1) > 0) {
      // eslint-disable-next-line no-await-in-loop
      const eng = await getDREF(uid).then((x) => Number(x?.directreferral || 0)).catch(() => null);
      if (eng != null && Number(r.i1) - eng > TOL) flagged[1].push({ uid, username: r.username, stored: Number(r.i1), engine: eng, over: Number(r.i1) - eng });
    }
    if (opt.types.has('5') && Number(r.i5) > 0) {
      // eslint-disable-next-line no-await-in-loop
      const status = await buildHiFiveStatus(uid).catch(() => null);
      if (status) {
        const ent = (status.packageBonus?.packages || []).reduce((s, p) => s + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0), 0);
        if (Number(r.i5) - ent > TOL) flagged[5].push({ uid, username: r.username, stored: Number(r.i5), engine: ent, over: Number(r.i5) - ent });
      }
    }
    if (opt.types.has('3') && Number(r.i3) > 0) {
      // eslint-disable-next-line no-await-in-loop
      const eng = await getLeadershipBonus(uid).then((x) => Number(x || 0)).catch(() => null);
      if (eng != null && Number(r.i3) - eng > TOL) flagged[3].push({ uid, username: r.username, stored: Number(r.i3), engine: eng, over: Number(r.i3) - eng });
    }
    if (scanned % 100 === 0) process.stdout.write(`  …${scanned}/${rows.length}\r`);
  }

  const fmt = (n) => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
  const NAME = { 1: 'Direct Referral (ttlincome1)', 3: 'Leadership (ttlincome3)', 5: 'Hi-Five (ttlincome5)' };

  console.log(`\n========== ANOMALOUS-CREDIT CANDIDATES (stored > current entitlement) ==========`);
  let grand = 0;
  for (const t of ['1', '3', '5']) {
    if (!opt.types.has(t)) continue;
    const list = flagged[t].sort((a, b) => b.over - a.over);
    const total = list.reduce((s, x) => s + x.over, 0);
    grand += total;
    console.log(`\n--- ${NAME[t]} --- candidates=${list.length}  total_over=${fmt(total)}`);
    for (const x of list.slice(0, 25)) {
      console.log(`  uid=${String(x.uid).padEnd(9)} @${String(x.username).slice(0, 16).padEnd(16)} stored=${fmt(x.stored).padStart(12)} engine=${fmt(x.engine).padStart(12)} over=${fmt(x.over)}`);
    }
    if (list.length > 25) console.log(`  …and ${list.length - 25} more (use --csv for full list)`);
  }
  console.log(`\nGRAND TOTAL flagged over-credit (types ${[...opt.types].sort().join(',')}): ${fmt(grand)}`);

  if (opt.csv) {
    console.log('\n--- CSV (type,uid,username,stored,engine,over) ---');
    for (const t of ['1', '3', '5']) for (const x of flagged[t]) console.log(`${t},${x.uid},${x.username},${x.stored},${x.engine},${x.over}`);
  }

  console.log(`\n⚠️  A flag = stored > CURRENT entitlement. INVESTIGATION CANDIDATE, not proof of fraud:`);
  console.log(`    could be a genuine mispay OR a legitimate past payment whose downline later shrank.`);
  console.log(`    Auto-credit never causes these (monotonic). Pairing(2)/Unilevel(4)/Ranking(6) excluded —`);
  console.log(`    see header for why. Read-only — nothing was written.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
