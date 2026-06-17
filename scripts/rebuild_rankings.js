/**
 * Recompute the entire ranking forest from scratch with the CURRENT rules
 * (downline-only repurchase points, Supervisor-1 advancement lock). Use after a
 * rule change so the leaderboard (rankingstab) reflects it for ALL members, not
 * just those who happen to recompute on activity.
 *
 *   node scripts/rebuild_rankings.js
 *
 * Heavy (full forest) — run off-peak. Safe: it computes points/ranks only; it does
 * NOT release rank cash incentives (that stays the guarded admin action).
 */
// IMPORTANT: load the env file (.env.dev / .env.prod) into process.env BEFORE
// requiring config/database — the pool is created at require-time from process.env.
// Just `require('./env')` does NOT load it; you must CALL loadBackendEnv().
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const { refreshRankingForest } = require('../services/ranking');
const { pool } = require('../config/database');

(async () => {
  const started = Date.now();
  try {
    const db = getDbConfig();
    console.log(`[rebuild] env=${envFile}  DB=${db.user}@${db.host}/${db.database}`);
    console.log('[rebuild] refreshing ranking forest (downline-only points, Supervisor-1 locked)…');
    const result = await refreshRankingForest();
    console.log(`[rebuild] done in ${((Date.now() - started) / 1000).toFixed(1)}s`, result || '');
  } catch (err) {
    console.error('[rebuild] error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
