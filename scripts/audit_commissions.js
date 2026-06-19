/**
 * READ-ONLY audit: commission coverage across income types 1-6. No writes.
 *
 * Concerns #7 ("commissions missing") and #9 ("unilevel inconsistent"). This does
 * NOT recompute money — it flags STRUCTURAL candidates (members who have the
 * structure to earn a type but show 0 stored), so each can be confirmed with a
 * per-account trace (diag_pairing.js etc.) before any money decision.
 *
 * Income map: 1=Direct Referral, 2=Binary Pairing, 3=Leadership, 4=Unilevel,
 *             5=Hi-Five, 6=Ranking Bonus.
 *
 * Usage (prod, read-only):  NODE_ENV=production node scripts/audit_commissions.js
 * This script only SELECTs. It never writes.
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const conn = await mysql.createConnection(cfg);
  console.log(`\n[audit_commissions] READ-ONLY · env=${envFile} db=${cfg.database}@${cfg.host}\n`);

  // ---- Coverage ----
  const [[members]] = await conn.query(`SELECT COUNT(*) AS n FROM usertab`);
  const [[payoutRows]] = await conn.query(`SELECT COUNT(*) AS n FROM payouttotaltab`);
  const [[noRow]] = await conn.query(
    `SELECT COUNT(*) AS n FROM usertab u
      WHERE NOT EXISTS (SELECT 1 FROM payouttotaltab p WHERE p.uid = u.uid)`);
  console.log(`Members: ${members.n} | payouttotaltab rows: ${payoutRows.n} | members with NO payout row: ${noRow.n}`);

  // ---- Earners per income type ----
  const [[byType]] = await conn.query(
    `SELECT
       SUM(ttlincome1 > 0) AS direct_referral,
       SUM(ttlincome2 > 0) AS binary_pairing,
       SUM(ttlincome3 > 0) AS leadership,
       SUM(ttlincome4 > 0) AS unilevel,
       SUM(ttlincome5 > 0) AS hifive,
       SUM(ttlincome6 > 0) AS ranking
     FROM payouttotaltab`);
  console.log('Members earning > 0, by type:', byType);

  // ---- FLAG 1: have direct referrals but ZERO direct-referral income ----
  const [drFlag] = await conn.query(
    `SELECT u.uid, m.username, COUNT(d.uid) AS directs, COALESCE(p.ttlincome1, 0) AS dr_income
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       JOIN usertab d ON d.drefid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      GROUP BY u.uid, m.username, p.ttlincome1
     HAVING directs > 0 AND dr_income = 0
      LIMIT 100`);
  console.log(`\nFLAG 1 — have direct referrals but ZERO direct-referral income: ${drFlag.length}${drFlag.length === 100 ? '+ (capped)' : ''}`);
  for (const r of drFlag.slice(0, 20)) console.log(`  uid=${r.uid} @${r.username} directs=${r.directs} dr_income=${r.dr_income}`);

  // ---- FLAG 2: both binary legs filled but ZERO pairing income ----
  // (Expected 0 for FS / unpaid-CD — code+cdstatus shown so those can be excluded.)
  const [pairFlag] = await conn.query(
    `SELECT u.uid, m.username, u.codeid, u.cdstatus,
            SUM(c.position = 1) AS left_kids, SUM(c.position = 2) AS right_kids,
            COALESCE(p.ttlincome2, 0) AS pairing_income
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       JOIN usertab c ON c.refid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      GROUP BY u.uid, m.username, u.codeid, u.cdstatus, p.ttlincome2
     HAVING left_kids > 0 AND right_kids > 0 AND pairing_income = 0
      LIMIT 100`);
  const pairFlagPaid = pairFlag.filter((r) => Number(r.codeid) === 1 || (Number(r.codeid) === 3 && Number(r.cdstatus) === 2));
  console.log(`\nFLAG 2 — both binary legs filled but ZERO pairing income: ${pairFlag.length}${pairFlag.length === 100 ? '+ (capped)' : ''}`);
  console.log(`         of which PAID/fully-paid-CD (should usually earn — investigate): ${pairFlagPaid.length}`);
  for (const r of pairFlagPaid.slice(0, 20)) {
    console.log(`  uid=${r.uid} @${r.username} code=${CODE_LABEL[r.codeid] || r.codeid} cd=${r.cdstatus} L=${r.left_kids} R=${r.right_kids} pairing=${r.pairing_income}`);
  }

  // ---- FLAG 3 (unilevel #9): have a downline but ZERO unilevel income ----
  // Unilevel needs 200 maintenance pts + monthly window, so 0 can be correct;
  // this only lists candidates to spot-check the live-vs-settlement consistency.
  const [uniFlag] = await conn.query(
    `SELECT u.uid, m.username, COUNT(d.uid) AS downline, COALESCE(p.ttlincome4, 0) AS uni_income
       FROM usertab u
       JOIN memberstab m ON m.uid = u.uid
       JOIN usertab d ON d.drefid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      GROUP BY u.uid, m.username, p.ttlincome4
     HAVING downline >= 5 AND uni_income = 0
      LIMIT 100`);
  console.log(`\nFLAG 3 — have >=5 direct downline but ZERO unilevel income (spot-check maintenance gate): ${uniFlag.length}${uniFlag.length === 100 ? '+ (capped)' : ''}`);
  for (const r of uniFlag.slice(0, 20)) console.log(`  uid=${r.uid} @${r.username} downline=${r.downline} uni_income=${r.uni_income}`);

  console.log('\nNOTE: structural flags only — NOT proof of missing money. FS / unpaid-CD');
  console.log('legitimately earn 0 pairing; unilevel needs 200 maintenance pts that month.');
  console.log('Confirm any flagged member with a per-account trace before any correction.\n');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
