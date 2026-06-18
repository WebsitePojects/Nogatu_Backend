/**
 * reconcile_rank_remaining.js  (READ-ONLY)
 *
 * Reconciles the stored ranking snapshot (rankingstab.basis_points /
 * consumed_points / remaining_rankable_points) against the live sponsor-tree
 * truth, to expose the "own-consumption counted twice" drift behind a ranked
 * member showing REMAINING = 0 while VERIFIED >> CONSUMED.
 *
 * For each ranked member it prints:
 *   rawDownline      = Σ repurchasetab.incentivepoints1 over sponsor tree (depth>0)
 *   othersConsumed   = Σ rank_global_consumptiontab.points_consumed for events
 *                      sourced in this member's subtree, consumed by OTHER members
 *   ownConsumed      = Σ rank_global_consumptiontab.points_consumed by THIS member
 *   storedGross/Consumed/Remaining  (current snapshot)
 *   correctGross     = rawDownline - othersConsumed
 *   correctRemaining = max(0, correctGross - ownConsumed)
 *   DRIFT flag when storedRemaining != correctRemaining
 *
 * No writes. Safe on prod. Prints env=/DB= first line per VPS command discipline.
 *
 * Usage:
 *   NODE_ENV=production node scripts/reconcile_rank_remaining.js [--limit 50] [--username Jervy01]
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${envFile} DB=${db.user}@${db.host}/${db.database}`);

  const limit = Math.max(1, Number(arg('limit', '50')) || 50);
  const username = arg('username', null);

  const conn = await mysql.createConnection(db);
  try {
    const where = username
      ? 'm.username = ?'
      : '(r.consumed_points > 0 OR r.highest_rank_no > 0 OR r.current_rank > 0)';
    const params = username ? [username] : [];

    const [members] = await conn.query(
      `SELECT u.uid, m.username,
              COALESCE(r.basis_points,0)              AS storedGross,
              COALESCE(r.consumed_points,0)           AS storedConsumed,
              COALESCE(r.remaining_rankable_points,0) AS storedRemaining,
              GREATEST(COALESCE(r.highest_rank_no,0),COALESCE(r.current_rank,0),COALESCE(r.rank_level,0)) AS rankNo
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN rankingstab r ON r.uid = u.uid
       WHERE u.uid = u.mainid AND ${where}
       ORDER BY r.consumed_points DESC, r.highest_rank_no DESC
       LIMIT ?`,
      [...params, limit]
    );

    if (!members.length) { console.log('No ranked members matched.'); return; }

    const num = (n) => Number(n || 0);
    const pad = (s, w) => String(s).padStart(w);
    console.log(
      `\n${'username'.padEnd(16)} ${pad('rank',4)} ${pad('rawDown',10)} ${pad('othCons',9)} ${pad('ownCons',9)} ` +
      `${pad('stGross',9)} ${pad('stCons',8)} ${pad('stRemain',9)} ${pad('okGross',9)} ${pad('okRemain',9)}  drift`
    );

    let drifted = 0;
    for (const mem of members) {
      const uid = num(mem.uid);

      const [[raw]] = await conn.query(
        `WITH RECURSIVE st AS (
           SELECT uid, 0 AS depth FROM usertab WHERE uid = ?
           UNION ALL
           SELECT u.uid, st.depth+1 FROM usertab u
             INNER JOIN st ON u.drefid = st.uid AND u.uid <> st.uid
           WHERE st.depth < 30
         )
         SELECT COALESCE(SUM(rp.incentivepoints1),0) AS rawDownline
         FROM repurchasetab rp
         INNER JOIN st ON st.uid = rp.uid AND st.depth > 0
         WHERE COALESCE(rp.incentivepoints1,0) > 0`,
        [uid]
      );

      // global consumption of events SOURCED in this member's subtree
      const [[cons]] = await conn.query(
        `WITH RECURSIVE st AS (
           SELECT uid, 0 AS depth FROM usertab WHERE uid = ?
           UNION ALL
           SELECT u.uid, st.depth+1 FROM usertab u
             INNER JOIN st ON u.drefid = st.uid AND u.uid <> st.uid
           WHERE st.depth < 30
         )
         SELECT
           COALESCE(SUM(CASE WHEN gc.consuming_member_uid <> ? THEN gc.points_consumed ELSE 0 END),0) AS othersConsumed,
           COALESCE(SUM(CASE WHEN gc.consuming_member_uid =  ? THEN gc.points_consumed ELSE 0 END),0) AS ownConsumed
         FROM rank_global_consumptiontab gc
         INNER JOIN repurchasetab rp ON rp.id = gc.repurchase_id
         INNER JOIN st ON st.uid = rp.uid AND st.depth > 0`,
        [uid, uid, uid]
      );

      const rawDownline    = num(raw.rawDownline);
      const othersConsumed = num(cons.othersConsumed);
      const ownConsumed    = num(cons.ownConsumed);
      const correctGross   = Math.max(0, rawDownline - othersConsumed);
      const correctRemain  = Math.max(0, correctGross - ownConsumed);
      const drift = Math.abs(correctRemain - num(mem.storedRemaining)) >= 1;
      if (drift) drifted += 1;

      console.log(
        `${String(mem.username || uid).padEnd(16)} ${pad(num(mem.rankNo),4)} ${pad(rawDownline,10)} ${pad(othersConsumed,9)} ${pad(ownConsumed,9)} ` +
        `${pad(num(mem.storedGross),9)} ${pad(num(mem.storedConsumed),8)} ${pad(num(mem.storedRemaining),9)} ${pad(correctGross,9)} ${pad(correctRemain,9)}  ${drift ? 'DRIFT' : 'ok'}`
      );
    }

    console.log(`\n${drifted}/${members.length} member(s) drift (storedRemaining != correctRemaining).`);
    console.log('NOTE: read-only. correctGross/correctRemain are what the fixed snapshot will store. No money/awards involved.');
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
