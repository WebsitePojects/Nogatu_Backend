/**
 * Rank exclusions — flagged (company/system/main) accounts that must NEVER achieve
 * a rank, so they cannot consume the network's repurchase points irreversibly.
 *
 * The ranking engine loads the excluded set once per rebuild and zeroes an excluded
 * member's awards before any consumption row is written. Source of truth:
 * rank_exclusionstab (admin-managed). Read paths degrade safely if the table is
 * missing (pre-V034 environment) — exclusion simply has no effect.
 */
const { pool } = require('../config/database');

/** Whole excluded uid set (cheap — only a handful of flagged accounts). */
async function loadExcludedSet(conn = pool) {
  try {
    const [rows] = await conn.query('SELECT uid FROM rank_exclusionstab');
    return new Set(rows.map((r) => Number(r.uid)));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return new Set();
    throw err;
  }
}

async function isRankExcluded(uid, conn = pool) {
  try {
    const [rows] = await conn.query('SELECT 1 FROM rank_exclusionstab WHERE uid = ? LIMIT 1', [Number(uid)]);
    return rows.length > 0;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return false;
    throw err;
  }
}

/**
 * Release (give back) the consumption an account already made, back to the network:
 * delete its global + per-member consumption rows and its rank achievements. Used
 * when an account is flagged-excluded so the points it locked become available to
 * its real uplines again. The caller must recompute rankings afterwards so the
 * freed points re-settle the race. Idempotent; degrades safely if a table is absent.
 */
async function releaseConsumptionForUids(uids, conn = pool) {
  const ids = (Array.isArray(uids) ? uids : [uids]).map(Number).filter((v) => v > 0);
  if (ids.length === 0) return { global: 0, perMember: 0, achievements: 0 };
  const ph = ids.map(() => '?').join(',');
  const safeDel = async (sql) => {
    try { const [r] = await conn.query(sql, ids); return r.affectedRows || 0; }
    catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return 0; throw e; }
  };
  const global       = await safeDel(`DELETE FROM rank_global_consumptiontab WHERE consuming_member_uid IN (${ph})`);
  const perMember    = await safeDel(`DELETE FROM rank_point_consumptiontab  WHERE consuming_member_uid IN (${ph})`);
  const achievements = await safeDel(`DELETE FROM rank_achievementstab       WHERE member_uid          IN (${ph})`);
  return { global, perMember, achievements };
}

/** Flag (excluded=true) or unflag (false) an account. Returns the new state. */
async function setRankExclusion(uid, excluded, adminUid = null, reason = null, conn = pool) {
  const id = Number(uid);
  if (!id) throw new Error('uid required');
  if (excluded) {
    await conn.query(
      `INSERT INTO rank_exclusionstab (uid, reason, excluded_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), excluded_by = VALUES(excluded_by)`,
      [id, reason || null, adminUid || null]
    );
  } else {
    await conn.query('DELETE FROM rank_exclusionstab WHERE uid = ?', [id]);
  }
  return excluded;
}

module.exports = { loadExcludedSet, isRankExcluded, setRankExclusion, releaseConsumptionForUids };
