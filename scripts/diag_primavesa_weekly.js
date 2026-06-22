/**
 * READ-ONLY per-week pairing breakdown for one member (default Primavesa01 7266942).
 *
 * Re-runs the EXACT collection + matching logic from services/income/pairing.js (faithfully
 * copied) but instruments the weekly cap accounting so we can see, per ISO week:
 *    matched  = min-matched binary points that week (before caps)
 *    credited = what actually paid after the weekly + monthly caps
 *    capped   = matched - credited  (the sealed amount)
 * Then it VALIDATES that Σ credited equals the real engine's totalPay (getPairing) — if they
 * match, the per-week table is trustworthy and proves whether the cap loss is legitimate
 * (weeks pegged at the cap) or an over-cap bug. Writes nothing.
 *
 * Usage: NODE_ENV=production node scripts/diag_primavesa_weekly.js [uid]
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const { getISOWeek } = require('../utils/helpers');
const { getEffectiveAccountState, countsForPairingSource } = require('../services/accountState');
const { getPairing } = require('../services/income/pairing');
const {
  getPackagePairingDepthLimit, getPackagePairingWeeklyCap,
  getPackagePairingMonthlyCap, getPackageSealingPoint,
} = require('../services/packagePolicy');

function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
function normalizeToDay(d) { if (!d) return null; const s = String(d).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + ' 00:00:00' : null; }
function monthKeyForDate(d) { return String(d).slice(0, 7); }

async function getUpgradeAccounts(uid) {
  const [rows] = await pool.query(
    `SELECT uid, DATE_FORMAT(transdate,'%Y-%m-%d') as transdate, binarypoints, transtype
       FROM upgradetab WHERE transtype = 1 AND uid = ? ORDER BY transdate ASC, id ASC`, [uid]);
  return rows;
}
async function appendUpgrade(uid, side, leftPoints, rightPoints, allDates, totals) {
  const ups = await getUpgradeAccounts(uid);
  for (const up of ups) {
    const d = normalizeToDay(up.transdate);
    if (d) allDates.add(d);
    const e = { uid: up.uid, points: num(up.binarypoints), date: d, codeid: num(up.transtype || 0) };
    if (side === 'left') { leftPoints.push(e); totals.totalpointsleft += e.points; }
    else { rightPoints.push(e); totals.totalpointsright += e.points; }
  }
}
async function getNumLevels(parent, level, leftPoints, rightPoints, allDates, sideMap, totals, depthLimit) {
  if (depthLimit != null && level > depthLimit) return;
  const [rows] = await pool.query(
    `SELECT uid, refid, drefid, position, codeid, accttype, currentaccttype, cdamount, cdtotal,
            cdstatus, binarypoints, DATE_FORMAT(datereg,'%Y-%m-%d %H:%i:%s') as datereg
       FROM usertab WHERE refid = ?`, [parent]);
  for (const baseRow of rows) {
    const row = await getEffectiveAccountState(baseRow.uid, baseRow);
    if (!row) continue;
    const side = level === 1 ? (num(row.position) === 1 ? 'left' : 'right') : (sideMap[parent] || 'right');
    sideMap[row.uid] = side;
    const isSrc = countsForPairingSource(row);
    const baseDate = normalizeToDay(row.datereg);
    if (isSrc && baseDate) allDates.add(baseDate);
    if (isSrc) {
      const e = { uid: row.uid, points: num(row.binarypoints), date: baseDate, codeid: num(row.codeid || 0) };
      if (side === 'left') { leftPoints.push(e); totals.totalleft += 1; totals.totalpointsleft += e.points; }
      else { rightPoints.push(e); totals.totalright += 1; totals.totalpointsright += e.points; }
      if (num(row.accttype) < num(row.currentaccttype)) await appendUpgrade(row.uid, side, leftPoints, rightPoints, allDates, totals);
    }
    await getNumLevels(row.uid, level + 1, leftPoints, rightPoints, allDates, sideMap, totals, depthLimit);
  }
}

function weeklyBreakdown(leftPoints, rightPoints, allDates, accttype) {
  const sortedDates = Array.from(allDates).sort();
  const maxPay = getPackagePairingWeeklyCap(accttype) || 10000;
  const monthCap = getPackagePairingMonthlyCap(accttype) || 0;
  const sealingPoint = getPackageSealingPoint(accttype);
  let lcounter = 0, rcounter = 0, ttlbpay = 0;
  const weeklyCredits = new Map(), monthlyCredits = new Map();
  const week = new Map(); // weekKey -> { matched, credited }
  const perDate = [];

  for (const date of sortedDates) {
    let lt = 0; for (const lp of leftPoints) if (lp.date === date && (num(lp.codeid) === 1 || num(lp.codeid) === 3)) lt += num(lp.points);
    let rt = 0; for (const rp of rightPoints) if (rp.date === date && (num(rp.codeid) === 1 || num(rp.codeid) === 3)) rt += num(rp.points);
    lcounter += lt; rcounter += rt;
    let bpay;
    if (lcounter < rcounter) { bpay = lcounter; rcounter -= lcounter; lcounter = 0; }
    else if (rcounter < lcounter) { bpay = rcounter; lcounter -= rcounter; rcounter = 0; }
    else { bpay = rcounter; lcounter = 0; rcounter = 0; }
    const transWeek = num(getISOWeek(date));
    const monthKey = monthKeyForDate(date);
    const weekKey = `${String(date).slice(0, 4)}-W${String(transWeek).padStart(2, '0')}`;
    const weekRemaining = Math.max(0, maxPay - num(weeklyCredits.get(weekKey)));
    const monthRemaining = monthCap > 0 ? Math.max(0, monthCap - num(monthlyCredits.get(monthKey))) : bpay;
    const weeklyCredited = Math.min(bpay, weekRemaining, monthRemaining);
    const sealingRemaining = sealingPoint > 0 ? Math.max(0, sealingPoint - ttlbpay) : weeklyCredited;
    const credited = sealingPoint > 0 ? Math.min(weeklyCredited, sealingRemaining) : weeklyCredited;
    weeklyCredits.set(weekKey, num(weeklyCredits.get(weekKey)) + credited);
    if (monthCap > 0) monthlyCredits.set(monthKey, num(monthlyCredits.get(monthKey)) + credited);
    ttlbpay += credited;
    const w = week.get(weekKey) || { matched: 0, credited: 0 };
    w.matched += bpay; w.credited += credited; week.set(weekKey, w);
    if (bpay > 0 || credited > 0) perDate.push({ date: String(date).slice(0, 10), weekKey, matched: bpay, credited });
  }
  return { week, perDate, total: ttlbpay, weeklyCap: maxPay, monthCap };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayOf(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '---' : DOW[d.getUTCDay()];
}

async function main() {
  console.log(`[primavesa:weekly] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const uid = num(process.argv[2]) || 7266942;
  const eff = await getEffectiveAccountState(uid);
  const acct = num(eff?.currentaccttype || eff?.accttype || 0);

  const leftPoints = [], rightPoints = [], allDates = new Set(), sideMap = {};
  const totals = { totalleft: 0, totalpointsleft: 0, totalright: 0, totalpointsright: 0 };
  await getNumLevels(uid, 1, leftPoints, rightPoints, allDates, sideMap, totals, getPackagePairingDepthLimit(acct));
  const { week, perDate, total, weeklyCap, monthCap } = weeklyBreakdown(leftPoints, rightPoints, allDates, acct);

  // Validate against the real engine.
  const engine = await getPairing(uid, acct);

  console.log(`\nMember uid ${uid}  package code ${acct}  weeklyCap ${weeklyCap}  monthlyCap ${monthCap}`);
  console.log(`Legs: LEFT ${totals.totalpointsleft} pts / RIGHT ${totals.totalpointsright} pts  (matched min)\n`);

  console.log('  PER-DATE (only dates with pairing activity):');
  console.log('  DATE         DAY   WEEK      MATCHED   EARNED(credited)');
  for (const r of perDate) {
    const capped = r.matched - r.credited;
    console.log(`  ${r.date}   ${weekdayOf(r.date)}   ${r.weekKey}  ${String(r.matched).padStart(8)}  ${String(r.credited).padStart(8)}${capped > 0.5 ? `   (capped ${capped})` : ''}`);
  }

  console.log('\n  WEEK        MATCHED   CAP      CREDITED   CAPPED-OFF');
  let sumMatched = 0, sumCredited = 0, sumCapped = 0;
  for (const wk of Array.from(week.keys()).sort()) {
    const w = week.get(wk);
    const capped = w.matched - w.credited;
    sumMatched += w.matched; sumCredited += w.credited; sumCapped += capped;
    const flag = capped > 0.5 ? '  <== capped' : '';
    console.log(`  ${wk}   ${String(w.matched).padStart(8)}  ${String(weeklyCap).padStart(6)}  ${String(w.credited).padStart(8)}   ${String(capped).padStart(8)}${flag}`);
  }
  console.log('  ------------------------------------------------------------');
  console.log(`  TOTAL      ${String(sumMatched).padStart(8)}          ${String(sumCredited).padStart(8)}   ${String(sumCapped).padStart(8)}`);
  console.log(`\n  Σ credited (this script): ${total}   |   engine getPairing.totalPay: ${num(engine.totalPay)}   |   ${Math.abs(total - num(engine.totalPay)) <= 0.5 ? 'MATCH ✓ (breakdown is faithful)' : 'MISMATCH — do not trust breakdown'}`);
  console.log(`  Total matched ${sumMatched} - credited ${sumCredited} = ${sumCapped} sealed by the ${weeklyCap}/wk (+${monthCap}/mo) cap.`);
  await pool.end();
}
main().catch((e) => { console.error('[primavesa:weekly] FAILED:', e.message); process.exit(1); });
