/**
 * READ-ONLY audit: pairing over-credit — stored SMB that EXCEEDS the eligible weak leg.
 *
 * Rule (management, 2026-06-20): matched pairing can NEVER exceed the weaker leg.
 * The weak leg is min(eligible left points, eligible right points) — "eligible" =
 * PD or fully-paid CD only (countsForPairingSource), so FS / unpaid-CD never count.
 *
 * For each account with pairing income, this runs the CURRENT engine (getPairing,
 * which already excludes ineligible sources) and compares:
 *     stored ttlincome2   vs   pairedPts = min(eligible L, eligible R)
 * Where stored > pairedPts, the stored SMB is OVER-CREDITED — historical inflation
 * (a past bug that paid uplines from ineligible FS/unpaid-CD sources), now stuck
 * because the monotonic Math.max guard can only RAISE ttlincome2, never lower it.
 *
 * Read-only. Reports count + total over-credit + the worst offenders. NO writes.
 * Usage (prod):  NODE_ENV=production node scripts/audit_pairing_overcredit.js
 */
const { loadBackendEnv, getDbConfig } = require('./env');

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`\n[audit_pairing_overcredit] READ-ONLY · env=${envFile} DB=${db.user}@${db.host}/${db.database}\n`);

  const { pool } = require('../config/database');
  const { getPairing } = require('../services/income/pairing');

  const [rows] = await pool.query(
    `SELECT p.uid, p.ttlincome2, u.currentaccttype, u.codeid, u.cdstatus
       FROM payouttotaltab p
       JOIN usertab u ON u.uid = p.uid
      WHERE p.ttlincome2 > 0
      ORDER BY p.ttlincome2 DESC`
  );
  console.log(`Accounts with stored pairing (ttlincome2 > 0): ${rows.length}\n`);

  const CODE = { 1: 'PD', 2: 'FS', 3: 'CD' };
  let overCount = 0, overTotal = 0;
  let earnerCount = 0, earnerTotal = 0; // ineligible EARNERS (FS / unpaid-CD) with stored pairing
  const samples = [];
  const earnerSamples = [];
  let scanned = 0;

  for (const r of rows) {
    scanned += 1;
    const stored = Number(r.ttlincome2 || 0);
    let res;
    // eslint-disable-next-line no-await-in-loop
    try { res = await getPairing(Number(r.uid), Number(r.currentaccttype || 0)); }
    catch { continue; }
    const canEarn = Boolean(res.eligibility && res.eligibility.canEarnPairing);
    const weakLeg = Number(res.pairedPts || 0); // eligible min(L,R) — the hard ceiling

    if (!canEarn && stored > 1) {
      // The EARNER itself is ineligible (FS / unpaid-CD) — should earn 0 pairing, so
      // the WHOLE stored amount is wrong.
      earnerCount += 1;
      earnerTotal += stored;
      earnerSamples.push({ uid: r.uid, code: CODE[r.codeid] || r.codeid, cd: r.cdstatus, stored });
    } else if (canEarn && stored > weakLeg + 1) {
      overCount += 1;
      const over = stored - weakLeg;
      overTotal += over;
      samples.push({ uid: r.uid, stored, weakLeg, over, leftPts: Number(res.leftPts || 0), rightPts: Number(res.rightPts || 0) });
    }
    if (scanned % 200 === 0) console.error(`  …scanned ${scanned}/${rows.length}`);
  }

  console.log(`A) INELIGIBLE EARNERS (FS / unpaid-CD) that still have stored pairing: ${earnerCount}`);
  console.log(`   Their ENTIRE stored pairing is wrong:  PHP ${earnerTotal.toFixed(2)}   (= ${(earnerTotal / 250).toFixed(2)} PV)`);
  for (const s of earnerSamples.sort((a, b) => b.stored - a.stored).slice(0, 20)) {
    console.log(`     uid=${s.uid} ${s.code}${s.code === 'CD' ? `(cd=${s.cd})` : ''} stored=${s.stored}`);
  }
  console.log('');
  console.log(`B) ELIGIBLE earners OVER-CREDITED (stored > eligible weak-leg matched): ${overCount}`);
  console.log(`   Excess over the weak leg:  PHP ${overTotal.toFixed(2)}   (= ${(overTotal / 250).toFixed(2)} PV)\n`);
  console.log('--- B) worst offenders (up to 30) ---');
  for (const s of samples.sort((a, b) => b.over - a.over).slice(0, 30)) {
    console.log(`  uid=${s.uid} stored=${s.stored} weakLeg(min L,R)=${s.weakLeg} OVER=${s.over}  (L=${s.leftPts} R=${s.rightPts})`);
  }

  console.log('\nNOTE: read-only — nothing changed. weakLeg = eligible min(L,R) is the hard');
  console.log('ceiling; stored pairing must never exceed it. Over-credit = historical inflation');
  console.log('from ineligible (FS / unpaid-CD) sources, frozen by the monotonic guard.');
  console.log('Correcting it is a deliberate clawback — confirm per account and account for');
  console.log('any ALREADY-ENCASHED amount before lowering ttlincome2.\n');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
