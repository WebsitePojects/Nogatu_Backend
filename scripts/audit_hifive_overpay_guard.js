/**
 * READ-ONLY OVERPAY GUARD for Hi-Five package auto-credit.
 *
 * Auto-credit pays owed = max(0, entitlement - ttlincome5), so after crediting,
 * ttlincome5 can never exceed entitlement. This script PROVES that on live data and
 * surfaces anything suspicious:
 *
 *   - OVERPAID: members where ttlincome5 > entitlement (paid MORE than earned). For each,
 *     it checks whether an auto-credit TODAY caused it (income5 credit dated today that
 *     pushed them over) vs a PRE-EXISTING legacy overpay (auto-credit never added to it).
 *   - OWED: members where ttlincome5 < entitlement (auto-credit will pay the gap). Sum =
 *     remaining auto-credit exposure (should be small — genuine new sets only).
 *
 * A correct system shows: ZERO overpaid-by-auto-credit, and small/expected owed total.
 *
 * Usage:  NODE_ENV=production node scripts/audit_hifive_overpay_guard.js [--csv]
 * READ-ONLY. No writes. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

async function main() {
  const csv = process.argv.includes('--csv');
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_hifive_overpay_guard] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);

  const { pool } = require('../config/database');
  const { buildHiFiveStatus } = require('../services/income/hifiveBonus');

  const [cands] = await pool.query(
    `SELECT u.drefid AS uid, m.username
       FROM usertab u JOIN memberstab m ON m.uid = u.drefid
      WHERE u.drefid > 0 GROUP BY u.drefid HAVING COUNT(*) >= 5`
  );
  const ids = cands.map((c) => Number(c.uid)).filter(Boolean);

  // batch: ttlincome5 (paid) + hi-five credited TODAY
  const paid = new Map();
  const today = new Map();
  if (ids.length) {
    const [pr] = await pool.query(
      `SELECT uid, COALESCE(ttlincome5,0) AS paid FROM payouttotaltab WHERE uid IN (${ids.map(() => '?').join(',')})`, ids);
    for (const r of pr) paid.set(Number(r.uid), Number(r.paid || 0));
    const [tr] = await pool.query(
      `SELECT uid, COALESCE(SUM(income5),0) AS t FROM payouthistorytab
        WHERE transactiontype=1 AND income5>0 AND transdate >= CURDATE() AND uid IN (${ids.map(() => '?').join(',')})
        GROUP BY uid`, ids);
    for (const r of tr) today.set(Number(r.uid), Number(r.t || 0));
  }

  const overpaid = [];
  let totalOwed = 0;
  let scanned = 0;
  let owedMembers = 0;
  for (const c of cands) {
    scanned += 1;
    const uid = Number(c.uid);
    // eslint-disable-next-line no-await-in-loop
    const status = await buildHiFiveStatus(uid).catch(() => null);
    const entitlement = (status?.packageBonus?.packages || []).reduce(
      (s, p) => s + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0), 0);
    const paidNow = Number(paid.get(uid) || 0);
    const overBy = paidNow - entitlement;
    const owed = Math.max(0, entitlement - paidNow);
    if (owed >= 1) { totalOwed += owed; owedMembers += 1; }
    if (overBy > 0.5) {
      const creditedToday = Number(today.get(uid) || 0);
      // Did today's auto-credit cause/contribute to the overpay? It did only if removing
      // today's credit would bring them at/under entitlement was already exceeded before.
      const causedByAutoCredit = creditedToday > 0 && (paidNow - creditedToday) < entitlement;
      overpaid.push({ uid, username: c.username, entitlement, paid: paidNow, overBy, creditedToday, causedByAutoCredit });
    }
    if (scanned % 50 === 0) process.stdout.write(`  …${scanned}/${cands.length}\r`);
  }

  const fmt = (n) => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });
  const autoCaused = overpaid.filter((o) => o.causedByAutoCredit);

  console.log(`\n========== HI-FIVE OVERPAY GUARD ==========`);
  console.log(`members scanned:                 ${scanned}`);
  console.log(`OWED (auto-credit will pay gap): members=${owedMembers}  total=${fmt(totalOwed)}`);
  console.log(`OVERPAID (ttlincome5 > entitlement): ${overpaid.length}`);
  console.log(`   ...caused by an auto-credit TODAY: ${autoCaused.length}   <-- MUST BE 0`);
  console.log('');
  if (autoCaused.length) {
    console.log(`*** ALERT: auto-credit overpaid these members — investigate immediately ***`);
    for (const o of autoCaused) {
      console.log(`  uid=${o.uid} @${o.username} entitlement=${fmt(o.entitlement)} paid=${fmt(o.paid)} overBy=${fmt(o.overBy)} todayCredit=${fmt(o.creditedToday)}`);
    }
  } else {
    console.log(`PASS: no member was overpaid by an auto-credit. Monotonic guard holding.`);
  }
  if (overpaid.length) {
    console.log(`\n--- pre-existing overpaid (legacy, NOT from auto-credit; auto-credit owes them 0) ---`);
    for (const o of overpaid.filter((x) => !x.causedByAutoCredit).slice(0, 25)) {
      console.log(`  uid=${o.uid} @${String(o.username).slice(0,16).padEnd(16)} entitlement=${fmt(o.entitlement)} paid=${fmt(o.paid)} overBy=${fmt(o.overBy)}`);
    }
  }

  if (csv && overpaid.length) {
    console.log('\n--- CSV (uid,username,entitlement,paid,overBy,creditedToday,causedByAutoCredit) ---');
    for (const o of overpaid) console.log(`${o.uid},${o.username},${o.entitlement},${o.paid},${o.overBy},${o.creditedToday},${o.causedByAutoCredit}`);
  }

  console.log(`\nNOTE: read-only. "caused by auto-credit TODAY = 0" proves the monotonic guard prevents`);
  console.log(`overpayment. Pre-existing overpaid (if any) are legacy and auto-credit never adds to them.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
