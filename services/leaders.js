/**
 * Named leaders — "who among the leaders sits above this member".
 *
 * Admin Manage Codes shows, for a tagged account, the nearest leader above them
 * in EACH tree. The two trees are genuinely different and are NOT interchangeable:
 *   - Unilevel / sponsor tree = usertab.drefid (who recruited whom)
 *   - Binary tree             = usertab.refid  (placement)
 * The same member can sit under a different leader in each, so both are reported
 * separately and neither is derived from the other.
 *
 * Read-only. This module never writes, and touches no money table.
 *
 * The roster is pinned by uid, never by name: memberstab has no unique constraint
 * on names and duplicates genuinely exist (see .claude/rules/lessons.md), so
 * matching on a display name would eventually tag the wrong person. Confirmed
 * 2026-08-06 against prod — all six are Diamond (60) accounts.
 * To change the roster, edit this list (no migration needed).
 */
// Resolved lazily rather than at import time: this module is pure lookup logic,
// so unit tests can require it and inject a fake connection without needing the
// mysql driver present. At runtime this is the same shared pool as everywhere else.
function getPool() {
  return require('../config/database').pool;
}

const LEADERS = [
  { uid: 5726452, username: 'Lhee143',    name: 'Rosalie Mallari' },
  { uid: 1863904, username: 'Themaker',   name: 'Rowell Mahinay'  },
  { uid: 6475210, username: 'gmrs01',     name: 'Rolando Salva'   },
  { uid: 1509809, username: 'Tycoon01',   name: 'Rendell Jimenez' },
  { uid: 4045529, username: 'organicman', name: 'Armando Palma'   },
  { uid:  428268, username: 'Jervy01',    name: 'Jervy Latumbo'   },
];

const LEADER_BY_UID = new Map(LEADERS.map((l) => [Number(l.uid), l]));

// Depth cap is a safety stop, not a business rule — the walk climbs the WHOLE
// chain to the root because a leader can sit far above the member. `p.uid <> c.uid`
// stops a self-referencing row (root accounts point at themselves) from looping.
const MAX_DEPTH = 100;

function ancestorSql(parentColumn) {
  return `
    WITH RECURSIVE chain AS (
      SELECT uid, ${parentColumn} AS parent_uid, 0 AS depth
        FROM usertab WHERE uid = ?
      UNION ALL
      SELECT p.uid, p.${parentColumn}, c.depth + 1
        FROM usertab p
        JOIN chain c ON p.uid = c.parent_uid AND p.uid <> c.uid
       WHERE c.depth < ${MAX_DEPTH}
    )
    SELECT uid, depth FROM chain WHERE depth > 0 ORDER BY depth ASC`;
}

const SPONSOR_CHAIN_SQL = ancestorSql('drefid');
const BINARY_CHAIN_SQL  = ancestorSql('refid');

/**
 * Nearest leader strictly ABOVE `memberUid` in one tree.
 * Returns null when no leader is in the chain (a legitimate answer, not an error).
 * A member who IS a leader does not report themselves — depth > 0 only.
 */
async function findNearestLeader(memberUid, sql, conn = null) {
  const uid = Number(memberUid);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const db = conn || getPool();
  const [rows] = await db.query(sql, [uid]);
  for (const row of rows) {            // already ordered nearest-first
    const leader = LEADER_BY_UID.get(Number(row.uid));
    if (leader) {
      return { ...leader, depth: Number(row.depth) };
    }
  }
  return null;
}

/**
 * Both trees for one member: { unilevel, binary }, each either a leader or null.
 */
async function findLeadersForMember(memberUid, conn = pool) {
  const [unilevel, binary] = await Promise.all([
    findNearestLeader(memberUid, SPONSOR_CHAIN_SQL, conn),
    findNearestLeader(memberUid, BINARY_CHAIN_SQL, conn),
  ]);
  return { unilevel, binary };
}

module.exports = { LEADERS, LEADER_BY_UID, findLeadersForMember, findNearestLeader };
