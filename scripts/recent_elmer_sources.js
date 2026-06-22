/**
 * READ-ONLY: most recent ELIGIBLE binary source registrations under a root (default Elmer 6122895).
 *
 * Answers "who is the new user that encoded and triggered 250 into Elmer's SMB" — i.e. recent
 * NEW encodes in Elmer's binary subtree that contribute binary points to his leg. A Bronze
 * new-encode = 250, Silver = 500, Gold = 1000, etc. Only ELIGIBLE sources count
 * (codeid=1 PD, or codeid=3 cdstatus=2 fully-paid CD); FS / unpaid-CD contribute 0.
 *
 * Note: this lists the registration (base) contribution by datereg. A source landing on Elmer's
 * WEAK leg is what actually produces a matched payout; on the strong leg it waits as surplus.
 *
 * Usage: NODE_ENV=production node scripts/recent_elmer_sources.js [root] [limit] [tierFilter]
 *   e.g. NODE_ENV=production node scripts/recent_elmer_sources.js 6122895 30 10   # last 30 Bronze (250)
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');

const BINARY_VALUE = { 10: 250, 20: 500, 30: 1000, 40: 2500, 50: 5000, 60: 15000 };
const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

async function main() {
  console.log(`[recent-src] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const root = num(process.argv[2]) || 6122895;
  const limit = Math.max(1, Math.min(200, num(process.argv[3]) || 25));
  const tierFilter = num(process.argv[4]); // optional: only this currentaccttype (e.g. 10 = Bronze)
  const tierSql = tierFilter ? `AND u.currentaccttype = ${tierFilter}` : '';

  const [rows] = await pool.query(
    `WITH RECURSIVE bt AS (
       SELECT uid, refid, 0 AS d FROM usertab WHERE uid = ?
       UNION ALL
       SELECT c.uid, c.refid, b.d + 1 FROM bt b JOIN usertab c ON c.refid = b.uid AND c.uid <> b.uid
        WHERE b.d < 60
     )
     SELECT bt.uid, bt.d AS depth, u.accttype, u.currentaccttype, u.codeid, u.cdstatus,
            u.binarypoints, DATE_FORMAT(u.datereg,'%Y-%m-%d %H:%i') AS datereg, m.username
       FROM bt
       JOIN usertab u ON u.uid = bt.uid
       LEFT JOIN memberstab m ON m.uid = bt.uid
      WHERE bt.d > 0
        AND (u.codeid = 1 OR (u.codeid = 3 AND u.cdstatus = 2))
        ${tierSql}
      ORDER BY u.datereg DESC
      LIMIT ?`,
    [root, limit]
  );

  console.log(`\nMost recent ${rows.length} ELIGIBLE source encode(s) under uid ${root}` +
    `${tierFilter ? ` (tier ${PKG[tierFilter] || tierFilter})` : ''}:\n`);
  console.log('  DATE              uid        BIN   PACKAGE        depth  username');
  for (const r of rows) {
    const tier = num(r.currentaccttype);
    const upgraded = num(r.currentaccttype) > num(r.accttype);
    console.log(`  ${(r.datereg || '-').padEnd(16)}  ${String(num(r.uid)).padEnd(9)}  ${String(num(BINARY_VALUE[tier])).padStart(5)}  ` +
      `${(PKG[tier] || tier).padEnd(8)}${upgraded ? '(upg)' : '     '}  ${String(num(r.depth)).padStart(4)}  ${r.username || ''}`);
  }
  console.log('\nNOTE: BIN = base registration binary value contributed to the upline leg. 250 = a fresh Bronze encode.');
  console.log('      Whether it PAID Elmer depends on landing on his weak (left) leg + caps that day.');
  await pool.end();
}
main().catch((e) => { console.error('[recent-src] FAILED:', e.message); process.exit(1); });
