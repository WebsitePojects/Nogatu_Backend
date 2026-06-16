/**
 * Ranking Race Engine — Core computation primitives.
 *
 * Business rules (confirmed 2026-06-11):
 *   - Point basis: repurchase points from SPONSOR tree (drefid chain) only.
 *     Binary spillover (placed under you but not sponsored by you) does NOT count.
 *   - Bottom-up race: deepest sponsor-tree node qualifies first.
 *   - Zero-out: when a rank is achieved, consumed events are written to
 *     rank_global_consumptiontab so ancestors cannot reuse those points.
 */
const { pool } = require('../config/database');

// TEMPORARY LOCK (2026-06-16): advancement is held at Supervisor 1 (rank 1).
// Supervisor 2 and above are NOT awarded until the structural "leg" rule (BUG-2 —
// binary legs vs unilevel direct-lines) is decided and reconciled. This is the SAFE
// direction (it only blocks promotions, never grants one). Raise/remove to re-enable.
const MAX_AWARDABLE_RANK = 1;

function toNumber(value) {
  return Number(value || 0);
}

function sortRankableEvents(events = []) {
  return [...events].sort((a, b) => {
    const tsCompare = String(a.sourceEventTs || '').localeCompare(String(b.sourceEventTs || ''));
    if (tsCompare !== 0) return tsCompare;

    const idCompare = toNumber(a.sourceEventId) - toNumber(b.sourceEventId);
    if (idCompare !== 0) return idCompare;

    return toNumber(a.sourceMemberUid) - toNumber(b.sourceMemberUid);
  });
}

// ---------------------------------------------------------------------------
// Sponsor-tree rankable event collection
// ---------------------------------------------------------------------------

// Main query: sponsor tree (drefid) with global-consumption deduction.
// Returns only events with remaining > 0 after deducting globally consumed pts.
const SPONSOR_TREE_SQL = `
  WITH RECURSIVE sponsor_tree AS (
    SELECT uid, 0 AS depth
    FROM usertab
    WHERE uid = ?
    UNION ALL
    SELECT u.uid, st.depth + 1
    FROM usertab u
    INNER JOIN sponsor_tree st
            ON u.drefid = st.uid
           AND u.uid <> st.uid
    WHERE st.depth < 30
  ),
  gc_totals AS (
    SELECT repurchase_id, SUM(points_consumed) AS total_consumed
    FROM rank_global_consumptiontab
    GROUP BY repurchase_id
  )
  SELECT
      r.id        AS repurchase_id,
      r.uid       AS source_member_uid,
      ? AS owner_uid,
      st.depth    AS source_depth,
      GREATEST(0,
        COALESCE(r.incentivepoints1, 0) - COALESCE(gc.total_consumed, 0)
      ) AS points,
      r.transdate AS source_event_ts,
      r.processid AS source_process_id
    FROM repurchasetab r
    INNER JOIN sponsor_tree st ON st.uid = r.uid AND st.depth >= 0
    LEFT JOIN gc_totals gc ON gc.repurchase_id = r.id
    WHERE COALESCE(r.incentivepoints1, 0) > 0
      AND GREATEST(0,
            COALESCE(r.incentivepoints1, 0) - COALESCE(gc.total_consumed, 0)
          ) > 0
    ORDER BY r.transdate ASC, r.id ASC, r.uid ASC
`;

// Fallback: same query without the global-consumption filter.
// Used when rank_global_consumptiontab doesn't exist yet (pre-V023 environment).
const SPONSOR_TREE_SQL_NO_GC = `
  WITH RECURSIVE sponsor_tree AS (
    SELECT uid, 0 AS depth
    FROM usertab
    WHERE uid = ?
    UNION ALL
    SELECT u.uid, st.depth + 1
    FROM usertab u
    INNER JOIN sponsor_tree st
            ON u.drefid = st.uid
           AND u.uid <> st.uid
    WHERE st.depth < 30
  )
  SELECT
      r.id        AS repurchase_id,
      r.uid       AS source_member_uid,
      ? AS owner_uid,
      st.depth    AS source_depth,
      COALESCE(r.incentivepoints1, 0) AS points,
      r.transdate AS source_event_ts,
      r.processid AS source_process_id
    FROM repurchasetab r
    INNER JOIN sponsor_tree st ON st.uid = r.uid AND st.depth >= 0
    WHERE COALESCE(r.incentivepoints1, 0) > 0
    ORDER BY r.transdate ASC, r.id ASC, r.uid ASC
`;

async function listRankableEventsForMember(uid, conn = pool) {
  const memberUid = toNumber(uid);

  let rows;
  try {
    [rows] = await conn.query(SPONSOR_TREE_SQL, [memberUid, memberUid]);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      // V023 not applied yet — run without global-consumption filter.
      [rows] = await conn.query(SPONSOR_TREE_SQL_NO_GC, [memberUid, memberUid]);
    } else {
      throw err;
    }
  }

  return sortRankableEvents((rows || []).map((row) => ({
    sourceEventId:   toNumber(row.repurchase_id),
    sourceMemberUid: toNumber(row.source_member_uid),
    ownerUid:        toNumber(row.owner_uid || memberUid),
    sourceLeg:       'unilevel',  // sponsor tree has no binary left/right legs
    sourceDepth:     toNumber(row.source_depth),
    points:          toNumber(row.points),
    remainingPoints: toNumber(row.points),
    sourceEventTs:   row.source_event_ts,
    sourceProcessId: row.source_process_id || null,
  })));
}

// ---------------------------------------------------------------------------
// Point consumption helpers
// ---------------------------------------------------------------------------

function consumePointsForRank(events = [], requiredPoints = 0) {
  const target = toNumber(requiredPoints);
  const ordered = sortRankableEvents(events).map((event) => ({
    ...event,
    remainingPoints: toNumber(event.remainingPoints ?? event.points),
  }));

  if (target <= 0) {
    return {
      consumedPoints: 0,
      lastConsumedEventTs: null,
      consumptionRows: [],
      remainingEvents: ordered,
    };
  }

  let remainingNeeded = target;
  let lastConsumedEventTs = null;
  const consumptionRows = [];

  for (const event of ordered) {
    if (remainingNeeded <= 0) break;
    if (toNumber(event.remainingPoints) <= 0) continue;

    const pointsConsumed = Math.min(toNumber(event.remainingPoints), remainingNeeded);
    if (pointsConsumed <= 0) continue;

    event.remainingPoints = toNumber(event.remainingPoints) - pointsConsumed;
    remainingNeeded -= pointsConsumed;
    lastConsumedEventTs = event.sourceEventTs || lastConsumedEventTs;

    consumptionRows.push({
      sourceEventId:   toNumber(event.sourceEventId),
      sourceMemberUid: toNumber(event.sourceMemberUid),
      sourceLeg:       event.sourceLeg || 'unilevel',
      sourceDepth:     toNumber(event.sourceDepth),
      sourceEventTs:   event.sourceEventTs,
      pointsConsumed,
      sourceProcessId: event.sourceProcessId || null,
    });
  }

  const consumedPoints = target - Math.max(0, remainingNeeded);
  return {
    consumedPoints,
    lastConsumedEventTs,
    consumptionRows,
    remainingEvents: ordered,
  };
}

// ---------------------------------------------------------------------------
// Rank award computation
// ---------------------------------------------------------------------------

function computeRankAwardsFromEvents({
  memberUid,
  rankDefinitions = [],
  rankableEvents = [],
  subtreeQualifiedRankCounts = {},
  existingAchievements = [],
  grossRankablePoints = null,
  consumedPoints = 0,
}) {
  const orderedDefinitions = [...rankDefinitions].sort(
    (a, b) => toNumber(a.sort_order || a.rank) - toNumber(b.sort_order || b.rank)
  );
  const remainingEvents = sortRankableEvents(rankableEvents).map((event) => ({
    ...event,
    remainingPoints: toNumber(event.remainingPoints ?? event.points),
  }));

  const startingConsumedPoints = toNumber(consumedPoints);
  const grossPoints = grossRankablePoints == null
    ? remainingEvents.reduce((sum, event) => sum + toNumber(event.remainingPoints), 0) + startingConsumedPoints
    : toNumber(grossRankablePoints);

  const awardedRanks = new Set(existingAchievements.map((achievement) => toNumber(achievement.rank)));
  let runningConsumedPoints = startingConsumedPoints;
  let currentRank = awardedRanks.size > 0 ? Math.max(...awardedRanks) : 0;
  const newAwards = [];

  for (const definition of orderedDefinitions) {
    const rankNo = toNumber(definition.rank);
    // LOCK: do not award Supervisor 2+ until the BUG-2 leg rule is decided.
    if (rankNo > MAX_AWARDABLE_RANK) break;
    if (rankNo <= 0 || rankNo <= currentRank) continue;

    const counts = subtreeQualifiedRankCounts[rankNo] || {};
    const leftQualifiedCount  = toNumber(counts.leftQualifiedCount);
    const rightQualifiedCount = toNumber(counts.rightQualifiedCount);
    const leftRequirementMet  = toNumber(definition.left_rank_required)  <= 0 || leftQualifiedCount  > 0;
    const rightRequirementMet = toNumber(definition.right_rank_required) <= 0 || rightQualifiedCount > 0;
    if (!leftRequirementMet || !rightRequirementMet) break;

    const availablePoints = remainingEvents.reduce((sum, e) => sum + toNumber(e.remainingPoints), 0);
    const pointsRequired  = toNumber(definition.points_required);
    if (availablePoints < pointsRequired) break;

    const outcome = consumePointsForRank(remainingEvents, pointsRequired);
    runningConsumedPoints += outcome.consumedPoints;
    remainingEvents.splice(0, remainingEvents.length, ...outcome.remainingEvents);
    currentRank = rankNo;

    newAwards.push({
      rank:              rankNo,
      rankCode:          definition.rank_code,
      rankName:          definition.rank_name,
      pointsRequired,
      pointsConsumed:    outcome.consumedPoints,
      achievedAt:        outcome.lastConsumedEventTs,
      leftQualifiedCount,
      rightQualifiedCount,
      leftRequirementMet,
      rightRequirementMet,
      cashIncentive:     toNumber(definition.cash_incentive),
      incentiveSummary:  definition.incentive_summary || '',
      achievementStatus: 'pending_fulfillment',
      consumptionRows:   outcome.consumptionRows,
    });
  }

  const nextRankDefinition = orderedDefinitions.find(
    (definition) => toNumber(definition.rank) > currentRank
  ) || null;
  const nextCounts = nextRankDefinition
    ? (subtreeQualifiedRankCounts[toNumber(nextRankDefinition.rank)] || {})
    : {};

  return {
    memberUid:              toNumber(memberUid),
    awards:                 newAwards,
    currentRank,
    grossRankablePoints:    grossPoints,
    consumedPoints:         runningConsumedPoints,
    newConsumedPoints:      runningConsumedPoints - startingConsumedPoints,
    remainingRankablePoints: Math.max(0, grossPoints - runningConsumedPoints),
    remainingEvents,
    nextRank:               nextRankDefinition ? toNumber(nextRankDefinition.rank) : null,
    nextRankRequirement:    nextRankDefinition
      ? {
          rank:             toNumber(nextRankDefinition.rank),
          rankCode:         nextRankDefinition.rank_code,
          rankName:         nextRankDefinition.rank_name,
          pointsRequired:   toNumber(nextRankDefinition.points_required),
          leftRankRequired: toNumber(nextRankDefinition.left_rank_required),
          rightRankRequired: toNumber(nextRankDefinition.right_rank_required),
        }
      : null,
    leftRequirementMet:  !nextRankDefinition || toNumber(nextCounts.leftQualifiedCount)  >= toNumber(nextRankDefinition?.left_rank_required),
    rightRequirementMet: !nextRankDefinition || toNumber(nextCounts.rightQualifiedCount) >= toNumber(nextRankDefinition?.right_rank_required),
  };
}

function summarizeAchievementStatus(achievements = []) {
  const ordered = [...achievements].sort((a, b) => toNumber(a.rank) - toNumber(b.rank));
  const pending   = ordered.filter((a) => String(a.achievementStatus || a.status || '') === 'pending_fulfillment');
  const fulfilled = ordered.filter((a) => String(a.achievementStatus || a.status || '') === 'fulfilled');

  return {
    pendingCount:    pending.length,
    fulfilledCount:  fulfilled.length,
    nextPendingRank: pending[0] || null,
  };
}

module.exports = {
  listRankableEventsForMember,
  sortRankableEvents,
  consumePointsForRank,
  computeRankAwardsFromEvents,
  summarizeAchievementStatus,
};
