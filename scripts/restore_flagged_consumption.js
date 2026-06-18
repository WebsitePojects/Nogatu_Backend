/**
 * Release repurchase points that FLAGGED (rank-excluded) accounts already consumed,
 * back to the network, then rebuild rankings with exclusion enforced.
 *
 * Fixes the irreversible-consumption damage: e.g. a company account that reached
 * Supervisor 1 and locked thousands of a real member's points. Deleting its
 * global-consumption rows makes those points available again; the rebuild then
 * recomputes with the engine guard (flagged → zero awards), so they're not re-locked.
 *
 *   node scripts/restore_flagged_consumption.js          (verify DB line first!)
 *
 * Idempotent. Safe: releases points + recomputes; never auto-pays anything.
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const { pool } = require('../config/database');
const { loadExcludedSet } = require('../services/rankExclusions');
const { refreshRankingForest } = require('../services/ranking');

async function del(sql, params) {
  try { const [r] = await pool.query(sql, params); return r.affectedRows || 0; }
  catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return 0; throw e; }
}

(async () => {
  const started = Date.now();
  try {
    const db = getDbConfig();
    console.log(`[restore] env=${envFile}  DB=${db.user}@${db.host}/${db.database}`);

    const excluded = await loadExcludedSet();
    if (excluded.size === 0) { console.log('[restore] no flagged accounts — nothing to release.'); return; }
    const ids = Array.from(excluded);
    const ph = ids.map(() => '?').join(',');
    console.log(`[restore] ${ids.length} flagged account(s): ${ids.join(', ')}`);

    // Safety: destructive deletes. Dry-run by default; require an explicit --confirm
    // so this can never run unattended or by a fat-finger against the wrong DB.
    if (!process.argv.includes('--confirm')) {
      const [gcCount] = await pool.query(`SELECT COUNT(*) AS n FROM rank_global_consumptiontab WHERE consuming_member_uid IN (${ph})`, ids).catch(() => [[{ n: '?' }]]);
      console.log(`[restore] DRY RUN — would release ${gcCount?.[0]?.n} global-consumption row(s) (+ ledger + achievements) for the above account(s) and rebuild rankings.`);
      console.log('[restore] Re-run with  --confirm  to actually delete + rebuild. (Verify the DB line above first.)');
      return;
    }

    const gc = await del(`DELETE FROM rank_global_consumptiontab WHERE consuming_member_uid IN (${ph})`, ids);
    const pc = await del(`DELETE FROM rank_point_consumptiontab  WHERE consuming_member_uid IN (${ph})`, ids);
    const ach = await del(`DELETE FROM rank_achievementstab      WHERE member_uid          IN (${ph})`, ids);
    console.log(`[restore] released ${gc} global-consumption rows, ${pc} per-member ledger rows, removed ${ach} achievement(s).`);

    console.log('[restore] rebuilding rankings (exclusion enforced)…');
    await refreshRankingForest();
    console.log(`[restore] done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (err) {
    console.error('[restore] error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
