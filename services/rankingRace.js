const { pool } = require('../config/database');

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

async function listRankableEventsForMember(uid, conn = pool) {
  const memberUid = toNumber(uid);
  const [rows] = await conn.query(
    `SELECT
        r.id AS repurchase_id,
        r.uid AS source_member_uid,
        ? AS owner_uid,
        c.leg AS source_leg,
        COALESCE(r.incentivepoints1, 0) AS points,
        r.transdate AS source_event_ts,
        r.processid AS source_process_id
      FROM repurchasetab r
      INNER JOIN binary_tree_closuretab c
        ON c.descendant_uid = r.uid
       AND c.ancestor_uid = ?
      WHERE COALESCE(r.incentivepoints1, 0) > 0
      ORDER BY r.transdate ASC, r.id ASC, r.uid ASC`,
    [memberUid, memberUid]
  );

  return sortRankableEvents((rows || []).map((row) => ({
    sourceEventId: toNumber(row.repurchase_id),
    sourceMemberUid: toNumber(row.source_member_uid),
    ownerUid: toNumber(row.owner_uid || memberUid),
    sourceLeg: row.source_leg || 'unknown',
    points: toNumber(row.points),
    remainingPoints: toNumber(row.points),
    sourceEventTs: row.source_event_ts,
    sourceProcessId: row.source_process_id || null,
  })));
}

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
      sourceEventId: toNumber(event.sourceEventId),
      sourceMemberUid: toNumber(event.sourceMemberUid),
      sourceLeg: event.sourceLeg || 'unknown',
      sourceEventTs: event.sourceEventTs,
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

function computeRankAwardsFromEvents({
  memberUid,
  rankDefinitions = [],
  rankableEvents = [],
  subtreeQualifiedRankCounts = {},
  existingAchievements = [],
  grossRankablePoints = null,
  consumedPoints = 0,
}) {
  const orderedDefinitions = [...rankDefinitions].sort((a, b) => toNumber(a.sort_order || a.rank) - toNumber(b.sort_order || b.rank));
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
  let currentRank = awardedRanks.size > 0
    ? Math.max(...awardedRanks)
    : 0;
  const newAwards = [];

  for (const definition of orderedDefinitions) {
    const rankNo = toNumber(definition.rank);
    if (rankNo <= 0 || rankNo <= currentRank) continue;

    const counts = subtreeQualifiedRankCounts[rankNo] || {};
    const leftQualifiedCount = toNumber(counts.leftQualifiedCount);
    const rightQualifiedCount = toNumber(counts.rightQualifiedCount);
    const leftRequirementMet = toNumber(definition.left_rank_required) <= 0 || leftQualifiedCount > 0;
    const rightRequirementMet = toNumber(definition.right_rank_required) <= 0 || rightQualifiedCount > 0;
    if (!leftRequirementMet || !rightRequirementMet) break;

    const availablePoints = remainingEvents.reduce((sum, event) => sum + toNumber(event.remainingPoints), 0);
    const pointsRequired = toNumber(definition.points_required);
    if (availablePoints < pointsRequired) break;

    const outcome = consumePointsForRank(remainingEvents, pointsRequired);
    runningConsumedPoints += outcome.consumedPoints;

    remainingEvents.splice(0, remainingEvents.length, ...outcome.remainingEvents);
    currentRank = rankNo;

    newAwards.push({
      rank: rankNo,
      rankCode: definition.rank_code,
      rankName: definition.rank_name,
      pointsRequired,
      pointsConsumed: outcome.consumedPoints,
      achievedAt: outcome.lastConsumedEventTs,
      leftQualifiedCount,
      rightQualifiedCount,
      leftRequirementMet,
      rightRequirementMet,
      cashIncentive: toNumber(definition.cash_incentive),
      incentiveSummary: definition.incentive_summary || '',
      achievementStatus: 'pending_fulfillment',
      consumptionRows: outcome.consumptionRows,
    });
  }

  const nextRankDefinition = orderedDefinitions.find((definition) => toNumber(definition.rank) > currentRank) || null;
  const nextCounts = nextRankDefinition ? (subtreeQualifiedRankCounts[toNumber(nextRankDefinition.rank)] || {}) : {};
  const leftRequirementMet = nextRankDefinition
    ? (toNumber(nextRankDefinition.left_rank_required) <= 0 || toNumber(nextCounts.leftQualifiedCount) > 0)
    : false;
  const rightRequirementMet = nextRankDefinition
    ? (toNumber(nextRankDefinition.right_rank_required) <= 0 || toNumber(nextCounts.rightQualifiedCount) > 0)
    : false;

  return {
    memberUid: toNumber(memberUid),
    awards: newAwards,
    currentRank,
    grossRankablePoints: grossPoints,
    consumedPoints: runningConsumedPoints,
    newConsumedPoints: runningConsumedPoints - startingConsumedPoints,
    remainingRankablePoints: Math.max(0, grossPoints - runningConsumedPoints),
    remainingEvents,
    nextRank: nextRankDefinition ? toNumber(nextRankDefinition.rank) : null,
    nextRankRequirement: nextRankDefinition
      ? {
        rank: toNumber(nextRankDefinition.rank),
        rankCode: nextRankDefinition.rank_code,
        rankName: nextRankDefinition.rank_name,
        pointsRequired: toNumber(nextRankDefinition.points_required),
        leftRankRequired: toNumber(nextRankDefinition.left_rank_required),
        rightRankRequired: toNumber(nextRankDefinition.right_rank_required),
      }
      : null,
    leftRequirementMet,
    rightRequirementMet,
  };
}

function summarizeAchievementStatus(achievements = []) {
  const ordered = [...achievements].sort((a, b) => toNumber(a.rank) - toNumber(b.rank));
  const pending = ordered.filter((achievement) => String(achievement.achievementStatus || achievement.status || '') === 'pending_fulfillment');
  const fulfilled = ordered.filter((achievement) => String(achievement.achievementStatus || achievement.status || '') === 'fulfilled');

  return {
    pendingCount: pending.length,
    fulfilledCount: fulfilled.length,
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
