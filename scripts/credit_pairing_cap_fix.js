/**
 * Audit + SURGICAL credit of the SMB under-payment caused by the wrong weekly-cap boundary.
 *
 * The pairing weekly cap was bucketed by ISO week (Mon-Sun) instead of the comp-plan week
 * (Tue 00:00 -> Mon 23:59 Asia/Manila). After the pairing.js fix (pairingWeekKey), this script
 * recomputes each member's pairing under the corrected cap and credits ONLY the owed PAIRING
 * delta -- so the dry-run total equals the commit total exactly (no other income type is touched).
 *
 * MONEY SAFETY (review checklist):
 *   - PAIRING-ONLY: writes only income2 / ttlincome2 (via insertIncome with paircash set, all
 *     other income fields 0). dref/leadership/unilevel/hifive are NOT recomputed or credited here,
 *     so the commit can never exceed the audited pairing owed.
 *   - MONOTONIC (no overpay, no clawback): newPairing = max(0, engineTotal - ttlincome2). A member
 *     whose corrected engine total is LOWER than already paid (was over-credited under the ISO bug)
 *     gets 0 and KEEPS their balance -- we never lower ttlincome2. Reported as OVER (kept).
 *   - NO UNDERPAY: every under-paid member is topped up to exactly their Tue-Mon entitlement.
 *   - ATOMIC: per-uid GET_LOCK (same key the live income calc uses) + own transaction with the
 *     wallet row re-read FOR UPDATE; ttlcashbalance is set to freshBalance + delta inside the lock.
 *   - IDEMPOTENT / NO DUPLICATE: re-running is a no-op (engine == paid -> delta 0). Running twice
 *     credits nothing the second time.
 *   - DRY-RUN by default; requires --commit. --uids restricts the set (use the dry-run list on BLUE).
 *
 * Usage:
 *   DRY-RUN (read-only):  node scripts/credit_pairing_cap_fix.js
 *   COMMIT (targeted):    NODE_ENV=production node scripts/credit_pairing_cap_fix.js --commit --uids 7266942,...
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const { getPairing } = require('../services/income/pairing');
const { getEffectiveAccountState } = require('../services/accountState');
const { insertIncome } = require('../services/income/insertIncome');

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

// SURGICAL pairing-only monotonic credit (atomic). Returns the amount credited (0 if none).
async function creditPairingOnly(uid, engineTotalPay) {
  const conn = await pool.getConnection();
  const lockKey = `nogatu_income_calc_${Number(uid)}`;
  try {
    const [lk] = await conn.query('SELECT GET_LOCK(?, 10) AS s', [lockKey]);
    if (Number(lk[0]?.s) !== 1) throw new Error('income lock timeout');
    await conn.beginTransaction();
    try {
      const [rows] = await conn.query(
        'SELECT ttlincome2, ttlcashbalance FROM payouttotaltab WHERE uid = ? FOR UPDATE', [uid]);
      const paid = n(rows[0]?.ttlincome2);
      const bal = n(rows[0]?.ttlcashbalance);
      const delta = Math.max(0, n(engineTotalPay) - paid); // monotonic: never negative
      if (delta >= 1) {
        await insertIncome(uid, {
          paircash: delta,
          beginningbalance: bal,
          endingbalance: bal + delta, // insertIncome sets ttlcashbalance = endingbalance (absolute)
        }, conn);
      }
      await conn.commit();
      return delta;
    } catch (txErr) { await conn.rollback(); throw txErr; }
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch (e) { /* ignore */ }
    conn.release();
  }
}

async function main() {
  console.log(`[cap-fix] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  MODE=${COMMIT ? 'COMMIT (writes pairing only)' : 'DRY-RUN (read-only)'}`);

  let cands;
  if (UIDS.length) {
    const ph = UIDS.map(() => '?').join(',');
    [cands] = await pool.query(
      `SELECT p.uid, p.ttlincome2, u.currentaccttype, u.accttype
         FROM payouttotaltab p JOIN usertab u ON u.uid = p.uid WHERE p.uid IN (${ph})`, UIDS);
  } else {
    [cands] = await pool.query(
      `SELECT p.uid, p.ttlincome2, u.currentaccttype, u.accttype
         FROM payouttotaltab p JOIN usertab u ON u.uid = p.uid
        WHERE p.ttlincome2 >= ? ORDER BY p.ttlincome2 DESC`, [MIN]);
  }
  console.log(`[cap-fix] scanning ${cands.length} member(s)${UIDS.length ? ' (targeted)' : ` with ttlincome2 >= ${MIN}`}...`);
  const [[before]] = await pool.query('SELECT ROUND(SUM(ttlincome2),2) s FROM payouttotaltab');

  const under = [];  // engine > paid : will be topped up
  const over = [];   // engine < paid : over-credited under the ISO bug; KEPT (monotonic)
  let i = 0;
  for (const c of cands) {
    i += 1;
    // eslint-disable-next-line no-await-in-loop
    const acct = await acctOf(c.uid, c.currentaccttype);
    // eslint-disable-next-line no-await-in-loop
    const eng = n((await getPairing(c.uid, acct)).totalPay);
    const delta = eng - n(c.ttlincome2);
    if (delta > 0.5) under.push({ uid: n(c.uid), paid: n(c.ttlincome2), engine: eng, delta });
    else if (delta < -0.5) over.push({ uid: n(c.uid), paid: n(c.ttlincome2), engine: eng, over: -delta });
    if (i % 50 === 0) console.error(`  ...scanned ${i}/${cands.length}`);
  }
  under.sort((a, b) => b.delta - a.delta);
  over.sort((a, b) => b.over - a.over);

  let totalOwed = 0;
  console.log(`\n[cap-fix] UNDER-PAID (engine > paid -> WILL CREDIT): ${under.length} member(s)`);
  for (const o of under) { totalOwed += o.delta; console.log(`  uid ${o.uid}  paid ${o.paid} -> engine ${o.engine}  OWED +${o.delta.toFixed(2)}`); }
  console.log(`[cap-fix] TOTAL TO CREDIT: ${totalOwed.toFixed(2)} across ${under.length} member(s)`);
  if (under.length) console.log(`[cap-fix] owed uids: ${under.map((o) => o.uid).join(',')}`);

  let totalOver = 0;
  for (const o of over) totalOver += o.over;
  console.log(`\n[cap-fix] OVER-PAID under the old ISO bug (KEPT, no clawback): ${over.length} member(s), total ${totalOver.toFixed(2)}`);
  for (const o of over) console.log(`  uid ${o.uid}  paid ${o.paid} -> engine ${o.engine}  (over by ${o.over.toFixed(2)} - NOT touched)`);

  if (!COMMIT) {
    console.log('\n[cap-fix] DRY-RUN: nothing written. Re-run with --commit --uids <owed list> to credit the pairing deltas.');
    await pool.end();
    return;
  }
  if (!under.length) { console.log('\n[cap-fix] nothing to credit.'); await pool.end(); return; }

  console.log('\n[cap-fix] COMMITTING pairing-only deltas (atomic, monotonic)...');
  let credited = 0;
  for (const o of under) {
    // eslint-disable-next-line no-await-in-loop
    const d = await creditPairingOnly(o.uid, o.engine);
    credited += d;
    console.log(`  uid ${o.uid}  credited +${d.toFixed(2)}`);
  }
  const [[after]] = await pool.query('SELECT ROUND(SUM(ttlincome2),2) s FROM payouttotaltab');
  console.log(`\n[cap-fix] credited ${credited.toFixed(2)} across ${under.length} member(s).`);
  console.log(`[cap-fix] SUM(ttlincome2): ${before.s} -> ${after.s}  (delta ${(n(after.s) - n(before.s)).toFixed(2)}; expect ~${totalOwed.toFixed(2)})`);
  console.log('[cap-fix] NOTE: pairing report (pairingstab) + downstream leadership self-heal on each member\'s next wallet load (monotonic). Only income2 was written here.');
  await pool.end();
}

main().catch((e) => { console.error('[cap-fix] FAILED:', e.message); process.exit(1); });
