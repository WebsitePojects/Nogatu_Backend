/**
 * Audit + credit the SMB under-payment caused by the wrong weekly-cap boundary.
 *
 * The pairing weekly cap was bucketed by ISO week (Mon-Sun) instead of the comp-plan week
 * (Tue 00:00 -> Mon 23:59 Asia/Manila). After the pairing.js fix (pairingWeekKey), this script
 * recomputes each member's pairing under the corrected cap and CREDITS the owed delta through the
 * existing monotonic path (calculateAndStoreIncome): newPairing = max(0, engineTotal - paid).
 *
 * SAFETY:
 *   - DRY-RUN by default (reports owed; writes nothing). Requires --commit to write.
 *   - Monotonic: can only RAISE an under-paid member; never claws back an over-paid one.
 *   - Idempotent + atomic: calculateAndStoreIncome holds a per-uid lock, re-reads the wallet row
 *     FOR UPDATE inside its own transaction, and re-running is a no-op once caught up.
 *   - Prints env/DB and SUM(ttlincome2) before/after for reconciliation.
 *   - --uids a,b,c  : restrict to specific members (use on BLUE with the list found on GREEN, so
 *                     prod isn't swept with hundreds of full-tree recomputes).
 *   - --min N       : only scan earners with ttlincome2 >= N (default 0 = all earners).
 *
 * Usage:
 *   GREEN size:   node scripts/credit_pairing_cap_fix.js
 *   BLUE verify:  NODE_ENV=production node scripts/credit_pairing_cap_fix.js --uids 7266942,...
 *   BLUE credit:  NODE_ENV=production node scripts/credit_pairing_cap_fix.js --commit --uids 7266942,...
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const { getPairing } = require('../services/income/pairing');
const { getEffectiveAccountState } = require('../services/accountState');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
function argVal(flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; }
const UIDS = (argVal('--uids') || '').split(',').map(Number).filter((x) => x > 0);
const MIN = Number(argVal('--min') || 0);
const n = (v) => { const x = Number(v || 0); return Number.isFinite(x) ? x : 0; };

async function acctOf(uid, fallback) {
  const eff = await getEffectiveAccountState(uid);
  return n(eff?.currentaccttype || eff?.accttype || fallback || 0);
}

async function main() {
  console.log(`[cap-fix] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  MODE=${COMMIT ? 'COMMIT (writes money)' : 'DRY-RUN (read-only)'}`);

  let cands;
  if (UIDS.length) {
    const ph = UIDS.map(() => '?').join(',');
    [cands] = await pool.query(
      `SELECT p.uid, p.ttlincome2, u.currentaccttype, u.accttype
         FROM payouttotaltab p JOIN usertab u ON u.uid = p.uid
        WHERE p.uid IN (${ph})`, UIDS);
  } else {
    [cands] = await pool.query(
      `SELECT p.uid, p.ttlincome2, u.currentaccttype, u.accttype
         FROM payouttotaltab p JOIN usertab u ON u.uid = p.uid
        WHERE p.ttlincome2 >= ? ORDER BY p.ttlincome2 DESC`, [MIN]);
  }
  console.log(`[cap-fix] scanning ${cands.length} member(s)${UIDS.length ? ' (targeted)' : ` with ttlincome2 >= ${MIN}`}...`);
  const [[before]] = await pool.query('SELECT ROUND(SUM(ttlincome2),2) s FROM payouttotaltab');

  const owed = [];
  let i = 0;
  for (const c of cands) {
    i += 1;
    // eslint-disable-next-line no-await-in-loop
    const acct = await acctOf(c.uid, c.currentaccttype);
    // eslint-disable-next-line no-await-in-loop
    const r = await getPairing(c.uid, acct);
    const delta = n(r.totalPay) - n(c.ttlincome2);
    if (delta > 0.5) owed.push({ uid: n(c.uid), paid: n(c.ttlincome2), engine: n(r.totalPay), delta });
    if (i % 50 === 0) console.error(`  ...scanned ${i}/${cands.length}`);
  }
  owed.sort((a, b) => b.delta - a.delta);

  let totalOwed = 0;
  console.log(`\n[cap-fix] UNDER-PAID (engine > paid under the Tue-Mon cap): ${owed.length} member(s)`);
  for (const o of owed) { totalOwed += o.delta; console.log(`  uid ${o.uid}  paid ${o.paid}  ->  engine ${o.engine}  OWED +${o.delta.toFixed(2)}`); }
  console.log(`[cap-fix] TOTAL OWED: ${totalOwed.toFixed(2)} across ${owed.length} member(s)`);
  if (owed.length) console.log(`[cap-fix] owed uids: ${owed.map((o) => o.uid).join(',')}`);

  if (!COMMIT) {
    console.log('\n[cap-fix] DRY-RUN: nothing written. Re-run with --commit (and ideally --uids <list>) to credit the owed deltas.');
    await pool.end();
    return;
  }
  if (!owed.length) { console.log('\n[cap-fix] nothing owed -> nothing to credit.'); await pool.end(); return; }

  console.log('\n[cap-fix] COMMITTING owed deltas via monotonic calculateAndStoreIncome (atomic per-uid)...');
  let credited = 0;
  for (const o of owed) {
    // eslint-disable-next-line no-await-in-loop
    const acct = await acctOf(o.uid);
    // eslint-disable-next-line no-await-in-loop
    const [[b]] = await pool.query('SELECT ttlincome2 v FROM payouttotaltab WHERE uid = ?', [o.uid]);
    // eslint-disable-next-line no-await-in-loop
    await calculateAndStoreIncome(o.uid, acct);
    // eslint-disable-next-line no-await-in-loop
    const [[a]] = await pool.query('SELECT ttlincome2 v FROM payouttotaltab WHERE uid = ?', [o.uid]);
    const d = n(a.v) - n(b.v);
    credited += d;
    console.log(`  uid ${o.uid}  ttlincome2 ${n(b.v)} -> ${n(a.v)}  (+${d.toFixed(2)})`);
  }
  const [[after]] = await pool.query('SELECT ROUND(SUM(ttlincome2),2) s FROM payouttotaltab');
  console.log(`\n[cap-fix] credited ${credited.toFixed(2)} across ${owed.length} member(s).`);
  console.log(`[cap-fix] SUM(ttlincome2): ${before.s} -> ${after.s}  (delta ${(n(after.s) - n(before.s)).toFixed(2)})`);
  console.log('[cap-fix] NOTE: calculateAndStoreIncome also reconciles each member\'s other income types monotonically; downstream leadership for their uplines self-heals on the uplines\' next wallet load.');
  await pool.end();
}

main().catch((e) => { console.error('[cap-fix] FAILED:', e.message); process.exit(1); });
