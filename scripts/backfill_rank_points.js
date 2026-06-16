/**
 * Phase-1 shadow backfill + reconciliation.
 *
 *   node scripts/backfill_rank_points.js            # backfill then reconcile
 *   node scripts/backfill_rank_points.js --reconcile # reconcile only
 *
 * Backfill rebuilds member_rank_pointstab from repurchasetab + consumption, then
 * compares its remaining vs the engine's rankingstab.remaining_rankable_points and
 * prints any drift. This is the gate: the shadow table must reconcile (allowing for
 * STALE engine snapshots, which are expected to differ — those are the bug the
 * incremental path fixes) before the live leaderboard is ever switched to it.
 */
require('./env');
const { backfillAll, reconcile } = require('../services/rankPoints');
const { pool } = require('../config/database');

(async () => {
  try {
    const reconcileOnly = process.argv.includes('--reconcile');
    if (!reconcileOnly) {
      console.log('[backfill] rebuilding member_rank_pointstab …');
      const res = await backfillAll();
      console.log(`[backfill] done: ${res.repurchaseRows} repurchase rows, ${res.consumptionRows} consumption rows applied.`);
    }
    const drift = await reconcile();
    if (drift.length === 0) {
      console.log('[reconcile] PASS — shadow aggregate matches the engine for all members with current snapshots.');
    } else {
      console.log(`[reconcile] ${drift.length} member(s) differ (top 200). NOTE: members with STALE engine snapshots are EXPECTED to differ — the shadow value is the live-correct one. Investigate any where the engine snapshot is current.`);
      for (const d of drift.slice(0, 25)) {
        console.log(`  uid=${d.member_uid}  shadow=${d.shadow_remaining}  engine=${d.engine_remaining}  diff=${d.diff}`);
      }
    }
  } catch (err) {
    console.error('[backfill] error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
