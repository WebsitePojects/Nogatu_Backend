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

module.exports = { loadExcludedSet, isRankExcluded, setRankExclusion };
