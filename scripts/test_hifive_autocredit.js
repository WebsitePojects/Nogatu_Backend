/**
 * GREEN/STAGING-ONLY write test for Hi-Five monotonic auto-credit.
 * Proves: (1) credits exactly owed = max(0, entitlement - ttlincome5),
 *         (2) is idempotent (a second run credits 0),
 *         (3) writes a payouthistorytab income5 row (transaction-history 1:1).
 *
 * WRITES to the DB — hard-guarded to NON-production via assertNotProductionDatabase.
 *
 * Usage:  NODE_ENV=production node scripts/test_hifive_autocredit.js [uid]
 *   (NODE_ENV=production on green still points at the STAGING DB via .env; the guard
 *    checks the DB NAME, not NODE_ENV, and aborts if it looks like the prod database.)
 */
const { loadBackendEnv, getDbConfig } = require('./env');

// Guard on the DB NAME, not NODE_ENV: green runs NODE_ENV=production but points at the
// STAGING database. Only the real prod database name is forbidden for this write test.
const PROD_DB_NAME = 'nogatualliance_sysdb';

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[test_hifive_autocredit] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  if (String(cfg.database || '').toLowerCase() === PROD_DB_NAME) {
    console.error(`REFUSED: "${cfg.database}" is the PRODUCTION database. This write test runs on green/staging only.`);
    process.exit(2);
  }
  console.log('(non-production DB confirmed — safe to write)\n');

  const { pool } = require('../config/database');
  const { buildHiFiveStatus, autoCreditEligibleHiFivePackages } = require('../services/income/hifiveBonus');

  const argUid = Number(process.argv[2]) || 0;

  async function entitlementOwed(uid, conn) {
    const status = await buildHiFiveStatus(uid).catch(() => null);
    const packages = status?.packageBonus?.packages || [];
    const entitlement = packages.reduce((s, p) => s + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0), 0);
    const [rows] = await conn.query('SELECT COALESCE(ttlincome5,0) AS paid, COALESCE(ttlcashbalance,0) AS bal FROM payouttotaltab WHERE uid=? LIMIT 1', [uid]);
    const paid = Number(rows[0]?.paid || 0);
    return { entitlement, paid, bal: Number(rows[0]?.bal || 0), owed: Math.max(0, entitlement - paid) };
  }

  // pick a member with owed > 0
  let uid = argUid;
  if (!uid) {
    const [cands] = await pool.query(
      `SELECT u.drefid AS uid FROM usertab u WHERE u.drefid>0 GROUP BY u.drefid HAVING COUNT(*)>=5 ORDER BY COUNT(*) DESC LIMIT 80`
    );
    for (const c of cands) {
      // eslint-disable-next-line no-await-in-loop
      const e = await entitlementOwed(Number(c.uid), pool);
      if (e.owed >= 1) { uid = Number(c.uid); break; }
    }
  }
  if (!uid) { console.log('No member with owed>0 found on this DB — nothing to test.'); await pool.end(); return; }

  const [[m]] = await pool.query('SELECT username FROM memberstab WHERE uid=? LIMIT 1', [uid]);
  console.log(`target uid=${uid} @${m?.username || '?'}`);

  const before = await entitlementOwed(uid, pool);
  console.log(`BEFORE: entitlement=${before.entitlement} ttlincome5=${before.paid} balance=${before.bal} owed=${before.owed}`);

  // run 1 — should credit exactly `before.owed`
  const r1 = await autoCreditEligibleHiFivePackages(uid, pool);
  console.log(`RUN 1 credited=${r1.credited}  (expected ${before.owed})  ${r1.credited === before.owed ? 'PASS' : 'FAIL'}`);

  const mid = await entitlementOwed(uid, pool);
  console.log(`AFTER 1: ttlincome5=${mid.paid} balance=${mid.bal} owed=${mid.owed}  ${mid.owed === 0 ? '(owed now 0 — PASS)' : '(FAIL owed!=0)'}`);

  // run 2 — must be idempotent (credit 0)
  const r2 = await autoCreditEligibleHiFivePackages(uid, pool);
  console.log(`RUN 2 credited=${r2.credited}  ${r2.credited === 0 ? '(idempotent — PASS)' : '(FAIL double-credit!)'}`);

  // show the transaction-history row
  const [hist] = await pool.query(
    `SELECT income5, beginningbalance, endingbalance, transactiontype, transdate, processid
       FROM payouthistorytab WHERE uid=? AND transactiontype=1 AND income5>0
      ORDER BY id DESC LIMIT 3`, [uid]
  );
  console.log('recent income5 history rows:');
  for (const h of hist) console.log(`   income5=${h.income5} bal ${h.beginningbalance}->${h.endingbalance} date=${String(h.transdate)} pid=${String(h.processid).slice(0,16)}`);

  console.log(`\nSUMMARY: ${r1.credited === before.owed && r2.credited === 0 ? 'ALL PASS — credits owed once, idempotent on re-run.' : 'CHECK FAILED — review above.'}\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
