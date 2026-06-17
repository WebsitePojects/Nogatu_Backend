/**
 * Phase 1 — incremental repurchase-points aggregate (SHADOW mode).
 *
 * Maintains `member_rank_pointstab(gross_points, consumed_points)` by propagating
 * small deltas up the sponsor (drefid) ancestor chain — O(depth ≤ 30) per event —
 * instead of recomputing subtrees. remaining = gross - consumed.
 *
 * SHADOW: this does NOT drive the live leaderboard yet. It runs in parallel so we
 * can reconcile it against the existing engine before any display switch. It never
 * awards ranks (that stays in the validated race gate). Display-only aggregate.
 */
const { pool } = require('../config/database');

// Ancestors only (d > 0) — a member's OWN repurchase does NOT count toward their
// own ranking points (confirmed rule 2026-06-16: "you cannot contribute to your
// own computed repurchase points"); it only rolls UP to their uplines.
const ANCESTOR_CHAIN_SQL = `
  WITH RECURSIVE chain AS (
    SELECT uid, drefid, 0 AS d FROM usertab WHERE uid = ?
    UNION ALL
    SELECT p.uid, p.drefid, c.d + 1
    FROM usertab p JOIN chain c ON p.uid = c.drefid AND p.uid <> c.uid
    WHERE c.d < 30
  )
  SELECT uid FROM chain WHERE d > 0
`;

/**
 * Propagate +points of repurchase GROSS to the member + all sponsor ancestors.
 * Call exactly once per recorded repurchase (inside/after its transaction).
 */
async function applyRepurchaseDelta(conn, memberUid, points) {
  const uid = Number(memberUid);
  const p = Number(points);
  if (!uid || !Number.isFinite(p) || p === 0) return;
  await (conn || pool).query(
    `INSERT INTO member_rank_pointstab (member_uid, gross_points)
     SELECT ch.uid, ? FROM (${ANCESTOR_CHAIN_SQL}) ch
     ON DUPLICATE KEY UPDATE gross_points = gross_points + VALUES(gross_points)`,
    [p, uid]
  );
}

/**
 * Propagate +points of CONSUMPTION to the source member + all sponsor ancestors
 * (consumption is global; ancestors of the consumed event lose those points).
 * Call once per consumption row created by a rank achievement.
 */
async function applyConsumptionDelta(conn, sourceMemberUid, points) {
  const uid = Number(sourceMemberUid);
  const p = Number(points);
  if (!uid || !Number.isFinite(p) || p === 0) return;
  await (conn || pool).query(
    `INSERT INTO member_rank_pointstab (member_uid, consumed_points)
     SELECT ch.uid, ? FROM (${ANCESTOR_CHAIN_SQL}) ch
     ON DUPLICATE KEY UPDATE consumed_points = consumed_points + VALUES(consumed_points)`,
    [p, uid]
  );
}

/**
 * One-time backfill: rebuild the whole shadow table from scratch from
 * repurchasetab + rank_global_consumptiontab. Idempotent (truncate + refill).
 * Heavy (O(events × depth)); run off-peak from a script, not the request path.
 */
async function backfillAll() {
  const conn = await pool.getConnection();
  try {
    await conn.query('DELETE FROM member_rank_pointstab');
    // Gross: every repurchase event expanded to its ancestor chain.
    const [reps] = await conn.query(
      'SELECT uid, IFNULL(incentivepoints1,0) AS pts FROM repurchasetab WHERE IFNULL(incentivepoints1,0) <> 0'
    );
    for (const r of reps) {
      // eslint-disable-next-line no-await-in-loop
      await applyRepurchaseDelta(conn, r.uid, r.pts);
    }
    // Consumed: every consumption row expanded to the source's ancestor chain.
    const [cons] = await conn.query(
      'SELECT source_member_uid AS uid, points_consumed AS pts FROM rank_global_consumptiontab WHERE points_consumed <> 0'
    );
    for (const c of cons) {
      // eslint-disable-next-line no-await-in-loop
      await applyConsumptionDelta(conn, c.uid, c.pts);
    }
    return { repurchaseRows: reps.length, consumptionRows: cons.length };
  } finally {
    conn.release();
  }
}

/**
 * Reconcile the shadow aggregate against the engine's rankingstab for the given
 * uids (or a sample). Returns mismatches for the drift alert.
 */
async function reconcile(uids = null) {
  const where = Array.isArray(uids) && uids.length ? 'WHERE rp.member_uid IN (?)' : '';
  const [rows] = await pool.query(
    `SELECT rp.member_uid,
            rp.remaining_points AS shadow_remaining,
            rk.remaining_rankable_points AS engine_remaining,
            ABS(rp.remaining_points - IFNULL(rk.remaining_rankable_points,0)) AS diff
     FROM member_rank_pointstab rp
     LEFT JOIN rankingstab rk ON rk.uid = rp.member_uid
     ${where}
     HAVING diff > 0.5
     ORDER BY diff DESC
     LIMIT 200`,
    where ? [uids] : []
  );
  return rows;
}

module.exports = { applyRepurchaseDelta, applyConsumptionDelta, backfillAll, reconcile };
