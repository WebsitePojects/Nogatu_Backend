/**
 * READ-ONLY FAST pairing over-credit screen (single grouped SQL, no per-account
 * traversal). Two findings:
 *
 *   A) INELIGIBLE EARNERS — an FS (codeid=2) or unpaid-CD (codeid=3 & cdstatus<>2)
 *      account that still holds ttlincome2 > 0. It should earn 0; whole amount wrong.
 *
 *   B) OVER-CREDIT — stored ttlincome2 > eligible weak-leg matched, where eligible
 *      leg points are summed from binary_tree_closuretab counting only PD + fully-paid
 *      CD descendants. matched = min(eligLeft, eligRight). ttlincome2 must never exceed it.
 *
 * CAVEATS vs the accurate (getPairing) audit: this uses usertab.binarypoints via the
 * closure table — it does NOT add upgradetab pairing events and assumes the closure
 * table is complete. So treat B as CANDIDATES; confirm a big offender with
 * trace_pairing_overcredit.js before any correction.
 *
 * Usage (prod):  NODE_ENV=production node scripts/audit_pairing_overcredit_fast.js
 * Read-only.
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const ELIG = `(d.codeid = 1 OR (d.codeid = 3 AND d.cdstatus = 2 AND (d.cdamount <= 0 OR d.cdtotal >= d.cdamount)))`;
const CODE = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const conn = await mysql.createConnection(cfg);
  console.log(`\n[audit_pairing_overcredit_fast] READ-ONLY · env=${envFile} db=${cfg.database}@${cfg.host}\n`);

  // A) Ineligible earners with stored pairing.
  const [earners] = await conn.query(
    `SELECT u.uid, u.codeid, u.cdstatus, p.ttlincome2 AS smb
       FROM payouttotaltab p
       JOIN usertab u ON u.uid = p.uid
      WHERE p.ttlincome2 > 0
        AND NOT (u.codeid = 1 OR (u.codeid = 3 AND u.cdstatus = 2 AND (u.cdamount <= 0 OR u.cdtotal >= u.cdamount)))
      ORDER BY p.ttlincome2 DESC`
  );
  const earnerTotal = earners.reduce((s, r) => s + Number(r.smb || 0), 0);
  console.log(`A) INELIGIBLE EARNERS (FS / unpaid-CD) holding pairing: ${earners.length}`);
  console.log(`   ENTIRE stored pairing is wrong:  PHP ${earnerTotal.toFixed(2)}  (= ${(earnerTotal / 250).toFixed(2)} PV)`);
  for (const r of earners.slice(0, 25)) {
    console.log(`     uid=${r.uid} ${CODE[r.codeid] || r.codeid}${Number(r.codeid) === 3 ? `(cd=${r.cdstatus})` : ''} stored=${Number(r.smb)}`);
  }

  // B) Eligible-leg sums via closure table, then compare stored vs min(L,R).
  const [legRows] = await conn.query(
    `SELECT c.ancestor_uid AS uid,
            SUM(CASE WHEN c.leg = 'left'  AND ${ELIG} THEN d.binarypoints ELSE 0 END) AS elig_left,
            SUM(CASE WHEN c.leg = 'right' AND ${ELIG} THEN d.binarypoints ELSE 0 END) AS elig_right
       FROM binary_tree_closuretab c
       JOIN usertab d ON d.uid = c.descendant_uid
      WHERE c.depth > 0
      GROUP BY c.ancestor_uid`
  );
  const legMap = new Map(legRows.map((r) => [Number(r.uid), { l: Number(r.elig_left || 0), r: Number(r.elig_right || 0) }]));

  const [stored] = await conn.query(
    `SELECT p.uid, p.ttlincome2 AS smb
       FROM payouttotaltab p
       JOIN usertab u ON u.uid = p.uid
      WHERE p.ttlincome2 > 0
        AND (u.codeid = 1 OR (u.codeid = 3 AND u.cdstatus = 2 AND (u.cdamount <= 0 OR u.cdtotal >= u.cdamount)))`
  );

  let overCount = 0, overTotal = 0;
  const samples = [];
  for (const r of stored) {
    const legs = legMap.get(Number(r.uid)) || { l: 0, r: 0 };
    const weak = Math.min(legs.l, legs.r);
    const s = Number(r.smb || 0);
    if (s > weak + 1) {
      overCount += 1; overTotal += (s - weak);
      samples.push({ uid: r.uid, stored: s, weak, over: s - weak, l: legs.l, r: legs.r });
    }
  }
  console.log(`\nB) ELIGIBLE earners with stored > closure-eligible weak leg (CANDIDATES): ${overCount}`);
  console.log(`   Apparent excess:  PHP ${overTotal.toFixed(2)}  (= ${(overTotal / 250).toFixed(2)} PV)`);
  console.log('   --- worst (up to 30) — CONFIRM each with trace_pairing_overcredit.js ---');
  for (const s of samples.sort((a, b) => b.over - a.over).slice(0, 30)) {
    console.log(`     uid=${s.uid} stored=${s.stored} weak(min L,R)=${s.weak} over=${s.over}  (L=${s.l} R=${s.r})`);
  }

  console.log('\nNOTE: B uses the closure table + usertab.binarypoints only (no upgradetab events,');
  console.log('assumes closure complete) — so B rows are CANDIDATES. Trace a big one to confirm');
  console.log('before any clawback. A is exact (ineligible earner = whole amount wrong).\n');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
