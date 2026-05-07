const { pool } = require('../config/database');

async function getRankingExplanation(uid) {
  const memberUid = Number(uid);

  try {
    const [grossRows] = await pool.query(
      `SELECT
         COALESCE(SUM(bpe.point_value), 0) AS gross_points,
         COUNT(*) AS event_count,
         MIN(bpe.event_ts) AS first_event_ts,
         MAX(bpe.event_ts) AS last_event_ts
       FROM binary_tree_closuretab c
       INNER JOIN binary_point_eventstab bpe ON bpe.source_member_uid = c.descendant_uid
       WHERE c.ancestor_uid = ?
         AND c.depth > 0
         AND bpe.deleted_at IS NULL`,
      [memberUid]
    );

    const [consumptionRows] = await pool.query(
      `SELECT rpc.consumption_uid, rpc.consumed_member_uid, rpc.consuming_member_uid,
              rpc.points_consumed, rpc.consumed_at, rpc.explanation,
              rd.rank_code, rd.rank_name,
              m.username AS consuming_username
       FROM rank_point_consumptiontab rpc
       LEFT JOIN rank_achievementstab ra ON ra.achievement_uid = rpc.consuming_rank_uid
       LEFT JOIN rank_definitionstab rd ON rd.definition_uid = ra.rank_definition_uid
       LEFT JOIN memberstab m ON m.uid = rpc.consuming_member_uid
       WHERE rpc.consumed_member_uid = ?
       ORDER BY rpc.consumed_at DESC, rpc.id DESC
       LIMIT 100`,
      [memberUid]
    );

    const [rankRows] = await pool.query(
      `SELECT rank_code, rank_name, points_required, left_rank_required, right_rank_required,
              incentive_summary, cash_incentive, sort_order
       FROM rank_definitionstab
       WHERE is_active = 1
       ORDER BY sort_order ASC`,
    );

    const grossPoints = Number(grossRows[0]?.gross_points || 0);
    const consumedPoints = consumptionRows.reduce((sum, row) => sum + Number(row.points_consumed || 0), 0);
    const remainingRankablePoints = Math.max(0, grossPoints - consumedPoints);

    return {
      source: 'binary_point_eventstab',
      grossPoints,
      consumedPoints,
      remainingRankablePoints,
      eventCount: Number(grossRows[0]?.event_count || 0),
      firstEventTs: grossRows[0]?.first_event_ts || null,
      lastEventTs: grossRows[0]?.last_event_ts || null,
      nextRanks: rankRows.map((rank) => ({
        ...rank,
        points_required: Number(rank.points_required || 0),
        cash_incentive: Number(rank.cash_incentive || 0),
        progressPercent: Number(rank.points_required || 0) > 0
          ? Math.min(100, Math.round((remainingRankablePoints / Number(rank.points_required)) * 10000) / 100)
          : 0,
      })),
      consumptionRows: consumptionRows.map((row) => ({
        consumptionUid: row.consumption_uid,
        consumingMemberUid: row.consuming_member_uid,
        consumingUsername: row.consuming_username,
        rankCode: row.rank_code,
        rankName: row.rank_name,
        pointsConsumed: Number(row.points_consumed || 0),
        consumedAt: row.consumed_at,
        explanation: row.explanation,
      })),
      explanation: 'Gross rank points come from eligible binary point events in your downline. If an upline wins a rank race first, the affected points remain visible here as consumed points with the upline, rank, timestamp, and explanation.',
      asOf: new Date().toISOString(),
    };
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;

    const [fallbackRows] = await pool.query(
      `SELECT totalpointsleft, totalpointsright, transdate
       FROM pairingstab
       WHERE uid = ?
       ORDER BY id DESC
       LIMIT 1`,
      [memberUid]
    );
    const fallback = fallbackRows[0] || {};
    const grossPoints = Number(fallback.totalpointsleft || 0) + Number(fallback.totalpointsright || 0);
    return {
      source: 'pairingstab_fallback',
      grossPoints,
      consumedPoints: 0,
      remainingRankablePoints: grossPoints,
      eventCount: 0,
      consumptionRows: [],
      explanation: 'Ranking ledger tables are not migrated yet, so this fallback uses the latest pairing snapshot. Run database migrations to enable full consumption transparency.',
      asOf: new Date().toISOString(),
    };
  }
}

module.exports = { getRankingExplanation };
