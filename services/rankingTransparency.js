const { pool } = require('../config/database');
const { listRankableEventsForMember } = require('./rankingRace');
const { getRankProgress, getRankDefinitions } = require('./ranking');

function toNumber(value) {
  return Number(value || 0);
}

async function getRankingExplanation(uid) {
  const memberUid = Number(uid);

  try {
    const [progress, rankDefinitions, rankableEvents, consumptionRows] = await Promise.all([
      getRankProgress(memberUid),
      getRankDefinitions(),
      listRankableEventsForMember(memberUid),
      pool.query(
        `SELECT
            rpc.consumption_uid,
            rpc.consumed_member_uid,
            rpc.consuming_member_uid,
            rpc.points_consumed,
            rpc.source_event_id,
            rpc.source_event_ts,
            rpc.source_leg,
            rpc.source_process_id,
            rpc.consumed_at,
            rpc.explanation,
            ra.achievement_uid,
            ra.achieved_at,
            ra.status AS achievement_status,
            rd.rank_code,
            rd.rank_name,
            rd.sort_order,
            src.username AS source_member_username
         FROM rank_point_consumptiontab rpc
         LEFT JOIN rank_achievementstab ra ON ra.achievement_uid = rpc.consuming_rank_uid
         LEFT JOIN rank_definitionstab rd ON rd.definition_uid = ra.rank_definition_uid
         LEFT JOIN memberstab src ON src.uid = rpc.consumed_member_uid
         WHERE rpc.consuming_member_uid = ?
         ORDER BY rpc.consumed_at ASC, rpc.id ASC`,
        [memberUid]
      ),
    ]);

    const ledgerRows = consumptionRows[0] || [];
    const grossRankablePoints = toNumber(progress.grossRankablePoints);
    const consumedPoints = toNumber(progress.consumedPoints);
    const remainingRankablePoints = toNumber(progress.remainingRankablePoints);
    const sortedEvents = [...rankableEvents].sort((a, b) => String(a.sourceEventTs || '').localeCompare(String(b.sourceEventTs || '')));
    const firstEventTs = sortedEvents[0]?.sourceEventTs || null;
    const lastEventTs = sortedEvents.at(-1)?.sourceEventTs || null;
    const rankDefinitionMap = new Map(rankDefinitions.map((definition) => [String(definition.rank_code || '').toLowerCase(), definition]));

    const nextRanks = rankDefinitions.map((rank) => ({
      ...rank,
      points_required: toNumber(rank.points_required),
      cash_incentive: toNumber(rank.cash_incentive),
      progressPercent: toNumber(rank.points_required) > 0
        ? Math.min(100, Math.round((remainingRankablePoints / toNumber(rank.points_required)) * 10000) / 100)
        : 0,
    }));

    return {
      source: 'repurchasetab + sponsor_tree (drefid)',
      basisLabel: progress.basisLabel || 'Repurchase points (sponsor tree)',
      grossRankablePoints,
      consumedPoints,
      remainingRankablePoints,
      grossPoints: grossRankablePoints,
      eventCount: rankableEvents.length,
      firstEventTs,
      lastEventTs,
      currentRank: progress.currentRank,
      currentRankLabel: progress.currentRankLabel,
      nextRank: progress.nextRank,
      nextRankLabel: progress.nextRankLabel,
      nextRankRequirement: progress.nextRankRequirement,
      leftRequirementMet: progress.leftRequirementMet,
      rightRequirementMet: progress.rightRequirementMet,
      achievements: progress.achievements || [],
      nextRanks,
      consumptionEvents: ledgerRows.map((row) => {
        const definition = rankDefinitionMap.get(String(row.rank_code || '').toLowerCase()) || null;
        return {
          consumptionUid: row.consumption_uid,
          achievementUid: row.achievement_uid,
          awardRank: toNumber(definition?.rank),
          awardRankCode: row.rank_code,
          awardRankName: row.rank_name,
          sourceMemberUid: toNumber(row.consumed_member_uid),
          sourceMemberUsername: row.source_member_username,
          sourceEventId: toNumber(row.source_event_id),
          sourceEventTs: row.source_event_ts,
          sourceLeg: row.source_leg || 'unknown',
          sourceProcessId: row.source_process_id || null,
          pointsConsumed: toNumber(row.points_consumed),
          consumedAt: row.consumed_at,
          achievementStatus: row.achievement_status,
          explanation: row.explanation,
        };
      }),
      consumptionRows: ledgerRows.map((row) => ({
        consumptionUid: row.consumption_uid,
        sourceMemberUid: toNumber(row.consumed_member_uid),
        sourceEventTs: row.source_event_ts,
        sourceLeg: row.source_leg || 'unknown',
        rankCode: row.rank_code,
        rankName: row.rank_name,
        pointsConsumed: toNumber(row.points_consumed),
        consumedAt: row.consumed_at,
        explanation: row.explanation,
      })),
      explanation: 'Ranking bonus uses repurchase points from your SPONSOR tree (drefid chain) only — binary spillover does not count. The race is bottom-up: deepest nodes qualify first. When a rank is awarded, the consumed events are zeroed globally so ancestors cannot reuse those same points.',
      asOf: new Date().toISOString(),
    };
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;

    const [fallbackRows] = await pool.query(
      `SELECT COALESCE(SUM(incentivepoints1), 0) AS gross_points,
              MIN(transdate) AS first_event_ts,
              MAX(transdate) AS last_event_ts
       FROM repurchasetab
       WHERE uid = ?
       LIMIT 1`,
      [memberUid]
    );
    const fallback = fallbackRows[0] || {};
    const grossPoints = toNumber(fallback.gross_points);
    return {
      source: 'repurchasetab_fallback',
      basisLabel: 'Repurchase points',
      grossRankablePoints: grossPoints,
      grossPoints,
      consumedPoints: 0,
      remainingRankablePoints: grossPoints,
      eventCount: 0,
      consumptionEvents: [],
      consumptionRows: [],
      firstEventTs: fallback.first_event_ts || null,
      lastEventTs: fallback.last_event_ts || null,
      explanation: 'Ranking ledger tables are not migrated yet, so this fallback uses repurchase points. Run database migrations to enable full consumption transparency.',
      asOf: new Date().toISOString(),
    };
  }
}

module.exports = { getRankingExplanation };
