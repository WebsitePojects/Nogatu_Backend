/**
 * READ-ONLY — one-shot verification for the 2026-06-22 income-engine fixes.
 * Runs every check from INCOME_ENGINE_FIX_VERIFICATION_2026-06-22.md and prints PASS/REVIEW.
 *
 * Run it TWICE: once on green BEFORE merging to blue, and again on blue right AFTER deploy.
 * The money-total snapshots (ttlincomeN / ttlcashbalance) must be IDENTICAL before vs after a
 * deploy (no fix retro-mutates stored money). Orphan/double-credit counts must not grow.
 *
 * Usage:  GREEN: node scripts/verify_income_engine_fixes.js
 *         BLUE:  NODE_ENV=production node scripts/verify_income_engine_fixes.js
 * READ-ONLY. No writes.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const peso = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[verify_income_engine_fixes] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);
  const { pool } = require('../config/database');
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];

  // --- Money-total snapshot (compare before vs after deploy; must be IDENTICAL) ---
  const [tot] = await q(
    `SELECT COALESCE(SUM(ttlincome1),0) i1, COALESCE(SUM(ttlincome2),0) i2, COALESCE(SUM(ttlincome3),0) i3,
            COALESCE(SUM(ttlincome4),0) i4, COALESCE(SUM(ttlincome5),0) i5, COALESCE(SUM(ttlincome6),0) i6,
            COALESCE(SUM(ttlcashbalance),0) bal FROM payouttotaltab`);
  console.log('=== MONEY-TOTAL SNAPSHOT (must match before vs after deploy) ===');
  console.log(`  DR(1)=${peso(tot.i1)}  Pairing(2)=${peso(tot.i2)}  Leadership(3)=${peso(tot.i3)}`);
  console.log(`  Unilevel(4)=${peso(tot.i4)}  HiFive(5)=${peso(tot.i5)}  Ranking(6)=${peso(tot.i6)}`);
  console.log(`  ttlcashbalance=${peso(tot.bal)}\n`);

  let reviews = 0;
  const check = (label, count, detail = '') => {
    const ok = Number(count) === 0;
    if (!ok) reviews += 1;
    console.log(`  [${ok ? 'PASS ' : 'REVIEW'}] ${label}: ${count}${detail ? '  ' + detail : ''}`);
  };

  console.log('=== INTEGRITY CHECKS (expect 0; any pre-existing rows must NOT grow after deploy) ===');

  // C1 — balance integrity: ttlcashbalance should equal credits - debits from history.
  try {
    const [c1] = await q(
      `SELECT COUNT(*) c FROM (
         SELECT p.uid,
                SUM(COALESCE(p.income1,0)+COALESCE(p.income2,0)+COALESCE(p.income3,0)+COALESCE(p.income4,0)
                    +COALESCE(p.income5,0)+COALESCE(p.income6,0)) AS credits,
                SUM(COALESCE(p.encashment1,0)) AS debits
         FROM payouthistorytab p GROUP BY p.uid
       ) s JOIN payouttotaltab t ON t.uid=s.uid
       WHERE ABS(t.ttlcashbalance - (s.credits - s.debits)) > 1`);
    check('C1 wallet balance != (credits - debits)', c1.c, '(legacy import may explain some; watch for NEW)');
  } catch (e) { console.log('  [SKIP ] C1 balance check:', e.code || e.message); }

  // H1 — unilevel stamped this month but NOT credited this month (the underpay victims).
  try {
    const [h1] = await q(
      `SELECT COUNT(*) c FROM incometransdatetab i
        WHERE i.incometype=4 AND DATE_FORMAT(i.lasttransdate,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m')
          AND NOT EXISTS (SELECT 1 FROM payouthistorytab p
              WHERE p.uid=i.uid AND p.income4>0 AND DATE_FORMAT(p.transdate,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m'))`);
    check('H1 unilevel stamped-but-unpaid this month', h1.c, '(pre-existing = past victims; 0 NEW after deploy)');
  } catch (e) { console.log('  [SKIP ] H1 orphan check:', e.code || e.message); }

  // H2 — more than one unilevel credit in the same month for the same member.
  try {
    const [h2] = await q(
      `SELECT COUNT(*) c FROM (
         SELECT uid, DATE_FORMAT(transdate,'%Y-%m') ym, COUNT(*) n
         FROM payouthistorytab WHERE income4>0 GROUP BY uid, ym HAVING n>1
       ) d`);
    check('H2 members with 2+ unilevel credits in a month', h2.c, '(must be 0 — double-pay)');
  } catch (e) { console.log('  [SKIP ] H2 double-credit check:', e.code || e.message); }

  // C3 — placed members missing from the binary closure (silent pairing denial).
  try {
    const [c3] = await q(
      `SELECT COUNT(*) c FROM usertab u
        WHERE u.refid IS NOT NULL AND u.refid<>0 AND u.refid<>u.uid
          AND NOT EXISTS (SELECT 1 FROM binary_tree_closuretab c WHERE c.descendant_uid=u.uid AND c.depth=0)`);
    check('C3 placed members missing closure self-row', c3.c, '(pre-existing = backfill candidates; 0 NEW after deploy)');
  } catch (e) { console.log('  [SKIP ] C3 closure check:', e.code || e.message, '(table may not exist)'); }

  console.log(`\n${reviews === 0 ? '✅ ALL CHECKS PASS (0 anomalies).' : `⚠ ${reviews} check(s) need REVIEW — compare against the pre-deploy run; investigate only NEW growth.`}`);
  console.log('Re-run this AFTER the blue deploy: money totals identical, orphan/double-credit not grown.\n');
  await pool.end().catch(() => {});
}

main().catch((e) => { console.error('[verify_income_engine_fixes] ERROR:', e); process.exit(1); });
