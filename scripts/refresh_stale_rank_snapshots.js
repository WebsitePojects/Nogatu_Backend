/**
 * Surgical refresh of specific members' rank ENGINE snapshots.
 *
 * Context: after rebuilding the display shadow (backfill_rank_points.js), reconcile
 * flagged members whose cached rankingstab snapshot lagged their true downline points
 * (shadow > engine). This recomputes ONLY the listed members' snapshots via the SAME
 * validated path the app uses after every maintenance/upgrade (refreshMemberRankSnapshot
 * -> rebuildRankSnapshot in its own transaction), so the engine catches up to the live
 * shadow and the two member-facing displays agree again.
 *
 * Safe by construction:
 *   - idempotent: recomputes from source; re-running is a no-op once current.
 *   - no auto-pay: any rank it awards lands as manual pending_fulfillment (admin releases).
 *   - prints engine BEFORE -> AFTER and the shadow target per uid, so the fix is observed.
 *
 * Usage:
 *   GREEN (staging): node scripts/refresh_stale_rank_snapshots.js
 *   BLUE  (prod):    NODE_ENV=production node scripts/refresh_stale_rank_snapshots.js
 *   Override the list: ... refresh_stale_rank_snapshots.js 3000014 7791079 ...
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const { refreshMemberRankSnapshot } = require('../services/ranking');

// The 15 stale-snapshot uids surfaced by the prod reconcile (2026-06-22). Override via argv.
const DEFAULT_UIDS = [
  3000014, 1, 4644523, 7791079, 6122895, 5726452, 819882,
  4660003, 8820472, 2873383, 2828724, 2837579, 6475210, 1019669, 266741,
];

async function readRemaining(uid) {
  const [[eng]] = await pool.query(
    'SELECT remaining_rankable_points AS v FROM rankingstab WHERE uid = ? LIMIT 1', [uid]
  );
  const [[sh]] = await pool.query(
    'SELECT remaining_points AS v FROM member_rank_pointstab WHERE member_uid = ? LIMIT 1', [uid]
  );
  return { engine: Number(eng?.v || 0), shadow: Number(sh?.v || 0) };
}

async function main() {
  console.log(`[refresh] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  const argvUids = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const targets = argvUids.length ? argvUids : DEFAULT_UIDS;
  console.log(`[refresh] refreshing ${targets.length} engine snapshot(s): ${targets.join(', ')}`);

  let changed = 0;
  let matched = 0;
  for (const uid of targets) {
    // eslint-disable-next-line no-await-in-loop
    const before = await readRemaining(uid);
    try {
      // eslint-disable-next-line no-await-in-loop
      await refreshMemberRankSnapshot(uid);
    } catch (error) {
      console.log(`  uid=${uid}  REFRESH FAILED: ${error.message}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const after = await readRemaining(uid);
    const isMatch = Math.abs(after.engine - after.shadow) <= 0.5;
    if (Math.abs(after.engine - before.engine) > 0.5) changed += 1;
    if (isMatch) matched += 1;
    console.log(
      `  uid=${uid}  engine ${before.engine} -> ${after.engine}  (shadow ${after.shadow})  ` +
      `${isMatch ? 'MATCH ✓' : 'STILL DIFFERS — investigate'}`
    );
  }
  console.log(`[refresh] done. ${changed} snapshot(s) changed, ${matched}/${targets.length} now match the shadow.`);
  await pool.end();
}

main().catch((err) => {
  console.error('[refresh] FAILED:', err.message);
  process.exit(1);
});
