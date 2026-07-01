/**
 * Ranking Bonus race engine — orchestration layer.
 *
 * Business rules (confirmed 2026-06-11):
 *   1. POINT BASIS: repurchase points come from SPONSOR tree (drefid chain) only.
 *      Binary spillover does NOT contribute.
 *   2. BOTTOM-UP RACE: deepest sponsor-tree node qualifies first (DFS, children processed
 *      before their parent). The first member to reach the threshold wins the race.
 *   3. ZERO-OUT: when a rank is achieved, all consumed repurchase events are written to
 *      rank_global_consumptiontab so those points cannot be counted again by ancestors.
 */
const { pool } = require('../config/database');
const { nowMySQL, getAccountTypeName } = require('../utils/helpers');
const { createProcessKey, createPublicId } = require('../utils/security');
const { writeAuditLog } = require('./audit');
const { getPackagePolicy, listPackagePolicies } = require('./packagePolicy');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('./schemaReadiness');
const {
  listRankableEventsForMember,
  computeRankAwardsFromEvents,
  computeDisplayBasis,
  summarizeAchievementStatus,
} = require('./rankingRace');
const { loadExcludedSet } = require('./rankExclusions');

const RANKING_BASIS_LABEL = 'Repurchase points (sponsor tree)';
const RACE_BASIS_MODE = 'sponsor-tree-repurchase';
const RANK_REFRESH_MAX_AGE_MINUTES = 15;

// ---------------------------------------------------------------------------
// Rank definitions
// ---------------------------------------------------------------------------

const RANK_COLORS = {
  0: '#6B7280',
  1: '#CD7F32',
  2: '#C0C0C0',
  3: '#FFD700',
  4: '#EF4444',
  5: '#DC2626',
  6: '#B91C1C',
  7: '#111827',
  8: '#1F2937',
  9: '#000000',
  10: '#EAB308',
};

const FULL_RANK_DEFINITIONS = [
  { rank: 1,  rank_code: 'supervisor_1', rank_name: 'Supervisor 1', points_required: 10000,   left_rank_required: 0, right_rank_required: 0, incentive_summary: 'D.P Motorcycle, 5,000 Cash, White T-shirt',                                                                            cash_incentive: 5000,    sort_order: 10  },
  { rank: 2,  rank_code: 'supervisor_2', rank_name: 'Supervisor 2', points_required: 20000,   left_rank_required: 1, right_rank_required: 1, incentive_summary: 'Laptop, 10,000 Cash, White Polo Shirt',                                                                                cash_incentive: 10000,   sort_order: 20  },
  { rank: 3,  rank_code: 'supervisor_3', rank_name: 'Supervisor 3', points_required: 40000,   left_rank_required: 2, right_rank_required: 2, incentive_summary: 'International Asian Travel, 20,000 cash, White polo shirt with red collar, Silver Pin',                                cash_incentive: 20000,   sort_order: 30  },
  { rank: 4,  rank_code: 'manager_1',    rank_name: 'Manager 1',    points_required: 60000,   left_rank_required: 3, right_rank_required: 3, incentive_summary: 'D.P Car Sedan, 30,000 Cash, Red T-Shirt',                                                                             cash_incentive: 30000,   sort_order: 40  },
  { rank: 5,  rank_code: 'manager_2',    rank_name: 'Manager 2',    points_required: 100000,  left_rank_required: 4, right_rank_required: 4, incentive_summary: 'D.P Car SUV, 50,000 Cash, Red Polo Shirt',                                                                            cash_incentive: 50000,   sort_order: 50  },
  { rank: 6,  rank_code: 'manager_3',    rank_name: 'Manager 3',    points_required: 200000,  left_rank_required: 5, right_rank_required: 5, incentive_summary: 'D.P Condo Unit, 100,000 Cash, Red Polo Shirt with Black Collar, Gold Pin',                                            cash_incentive: 100000,  sort_order: 60  },
  { rank: 7,  rank_code: 'director_1',   rank_name: 'Director 1',   points_required: 600000,  left_rank_required: 6, right_rank_required: 6, incentive_summary: 'Sedan Full Payment, 200,000 Cash, Black Shirt',                                                                       cash_incentive: 200000,  sort_order: 70  },
  { rank: 8,  rank_code: 'director_2',   rank_name: 'Director 2',   points_required: 1000000, left_rank_required: 7, right_rank_required: 7, incentive_summary: 'SUV Full Payment, 300,000 Cash, Black Polo Shirt',                                                                    cash_incentive: 300000,  sort_order: 80  },
  { rank: 9,  rank_code: 'director_3',   rank_name: 'Director 3',   points_required: 1600000, left_rank_required: 8, right_rank_required: 8, incentive_summary: 'Condo Fully Paid, 500,000 Cash, Black Polo Shirt, Black Jacket, Ring',                                               cash_incentive: 500000,  sort_order: 90  },
  { rank: 10, rank_code: 'ambassador',   rank_name: 'AMBASSADOR',   points_required: 2000000, left_rank_required: 9, right_rank_required: 9, incentive_summary: '1,000,000 Cash, Yellow Polo Shirt, White Jacket, 1 Pin and a ring, US travel for 2, One point for global bonus',     cash_incentive: 1000000, sort_order: 100 },
];

const PACKAGE_LABELS = Object.fromEntries(
  listPackagePolicies().map((policy) => [Number(policy.packageType), policy.packageLabel])
);

const RANK_REQUIREMENTS = FULL_RANK_DEFINITIONS.reduce((map, row) => {
  map[row.rank] = {
    minPoints: Number(row.points_required),
    label:     row.rank_name,
    color:     RANK_COLORS[row.rank] || RANK_COLORS[0],
  };
  return map;
}, {});

const RANK_INCENTIVES = FULL_RANK_DEFINITIONS.reduce((map, row) => {
  map[row.rank] = row.incentive_summary;
  return map;
}, {});

const RANK_CASH_INCENTIVES = FULL_RANK_DEFINITIONS.reduce((map, row) => {
  map[row.rank] = Number(row.cash_incentive || 0);
  return map;
}, {});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Per-member rebuild logs are extremely verbose (3 lines × every member in a
// recomputed subtree). Off by default so prod logs/disk aren't flooded; enable
// only for debugging with RANK_DEBUG=1.
const RANK_DEBUG = process.env.RANK_DEBUG === '1' || process.env.RANK_DEBUG === 'true';
function rankLog(event, data = {}) {
  if (!RANK_DEBUG) return;
  console.log(`[Ranking] ${event}`, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let rankingInfraReadyPromise = null;
const memberRefreshPromises = new Map();

function toNumber(value) {
  return Number(value || 0);
}

function toMysqlDateTime(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.replace('T', ' ').replace('Z', '');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// mysql2 returns DATETIME columns as JS Date objects, so String(date) produces
// "Wed Jun 24 2026..." (day-name-first) rather than a chronological string —
// localeCompare on that is NOT date order. Use epoch millis for tiebreak sorts.
// Missing dates sort LAST (treated as far future), matching the '9999-12-31' SQL fallback.
function dateSortValue(value) {
  if (value == null) return Number.MAX_SAFE_INTEGER;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function rankColor(rank) {
  return RANK_COLORS[toNumber(rank)] || RANK_COLORS[0];
}

function sumRepurchasePoints(rows) {
  return (rows || []).reduce((sum, row) => sum + toNumber(row.incentivepoints1 ?? row.ttlpoints), 0);
}

function normalizeRankDefinitions(definitionRows = []) {
  const orderedRows = [...definitionRows].sort((a, b) => toNumber(a.sort_order) - toNumber(b.sort_order));
  const rankByCode = new Map();
  orderedRows.forEach((row, index) => {
    rankByCode.set(String(row.rank_code || '').toLowerCase(), index + 1);
  });

  const normalizeRequirement = (value) => {
    if (value == null || value === '') return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
    return rankByCode.get(String(value).toLowerCase()) || 0;
  };

  return orderedRows.map((rank, index) => ({
    rank:              index + 1,
    definition_uid:    rank.definition_uid || null,
    rank_code:         rank.rank_code,
    rank_name:         rank.rank_name,
    points_required:   toNumber(rank.points_required),
    left_rank_required:  normalizeRequirement(rank.left_rank_required),
    right_rank_required: normalizeRequirement(rank.right_rank_required),
    incentive_summary: rank.incentive_summary || '',
    cash_incentive:    toNumber(rank.cash_incentive),
    sort_order:        toNumber(rank.sort_order || (index + 1) * 10),
    color:             rankColor(index + 1),
  }));
}

async function ensureRankingTable(conn = pool) {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.RANKING, 'Ranking', conn);
  await conn.query('INSERT IGNORE INTO rank_sequence_countertab (id, next_sequence) VALUES (1, 1)');
}

async function ensureRankingInfra() {
  if (!rankingInfraReadyPromise) {
    rankingInfraReadyPromise = ensureRankingTable().catch((error) => {
      rankingInfraReadyPromise = null;
      throw error;
    });
  }
  return rankingInfraReadyPromise;
}

async function getRankDefinitions(conn = pool) {
  try {
    const [definitionRows] = await conn.query(
      `SELECT definition_uid, rank_code, rank_name, points_required, left_rank_required, right_rank_required,
              incentive_summary, cash_incentive, sort_order
       FROM rank_definitionstab
       WHERE is_active = 1
       ORDER BY sort_order ASC`
    );
    if (definitionRows.length > 0) return normalizeRankDefinitions(definitionRows);
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  return normalizeRankDefinitions(FULL_RANK_DEFINITIONS);
}

// ---------------------------------------------------------------------------
// Package policy helpers
// ---------------------------------------------------------------------------

function getPackageRankingPolicy(packageType) {
  const numericPackageType = toNumber(packageType);
  const policy = getPackagePolicy(numericPackageType);
  const packageLabel = policy.packageLabel || PACKAGE_LABELS[numericPackageType] || getAccountTypeName(numericPackageType) || `Type ${numericPackageType}`;
  const maxPublishedRank = FULL_RANK_DEFINITIONS.reduce((max, row) => Math.max(max, toNumber(row.rank)), 0);
  const maxPublishedRankLabel = FULL_RANK_DEFINITIONS.find((row) => toNumber(row.rank) === maxPublishedRank)?.rank_name || null;

  return {
    packageType:              numericPackageType,
    packageLabel,
    rankingEligible:          true,
    maxRank:                  maxPublishedRank,
    maxRankLabel:             maxPublishedRankLabel,
    nextUpgradePackageType:   null,
    nextUpgradePackageLabel:  null,
    reason:                   null,
  };
}

function filterRankDefinitionsForPackage(definitions = [], _packageType) {
  return definitions.filter((definition) => toNumber(definition.rank) > 0);
}

function canReleaseRankAchievementForPackage(packageType, rankNo) {
  const numericRank = toNumber(rankNo);
  const policy = getPackageRankingPolicy(packageType);
  return Boolean(policy.rankingEligible) && numericRank > 0 && numericRank <= policy.maxRank;
}

function clampRankToPackage(packageType, rankNo) {
  const policy = getPackageRankingPolicy(packageType);
  return Math.min(policy.maxRank, Math.max(0, toNumber(rankNo)));
}

// ---------------------------------------------------------------------------
// DB read helpers
// ---------------------------------------------------------------------------

async function getLatestPairingSnapshot(uid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT totalbpay, totalleft, totalright, totalpointsleft, totalpointsright
     FROM pairingstab
     WHERE uid = ?
     ORDER BY transdate DESC, id DESC
     LIMIT 1`,
    [uid]
  );
  const row = rows[0] || {};
  return {
    binaryPoints: toNumber(row.totalbpay),
    leftCount:    toNumber(row.totalleft),
    rightCount:   toNumber(row.totalright),
    leftPoints:   toNumber(row.totalpointsleft),
    rightPoints:  toNumber(row.totalpointsright),
  };
}

/**
 * Returns direct sponsor children: members who have drefid = uid
 * (i.e. uid is their direct sponsor in the unilevel tree).
 * This is the correct tree for ranking (bottom-up, sponsor basis).
 */
async function getSponsorChildren(uid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT uid FROM usertab
     WHERE drefid = ? AND uid <> ?
     ORDER BY datereg ASC, uid ASC`,
    [uid, uid]
  );
  return rows.map((row) => toNumber(row.uid)).filter((v) => v > 0);
}

async function getAchievementRowsForMember(uid, conn = pool) {
  try {
    const [rows] = await conn.query(
      `SELECT
          ra.achievement_uid,
          ra.member_uid,
          ra.rank_definition_uid,
          ra.achieved_at,
          ra.last_consumed_event_ts,
          ra.sequence_id,
          ra.gross_points_at_achievement,
          ra.remaining_rankable_points,
          ra.status,
          ra.fulfilled_at,
          ra.admin_fulfilled_by,
          ra.fulfillment_notes,
          rd.rank_code,
          rd.rank_name,
          rd.points_required,
          rd.left_rank_required,
          rd.right_rank_required,
          rd.incentive_summary,
          rd.cash_incentive,
          rd.sort_order
       FROM rank_achievementstab ra
       INNER JOIN rank_definitionstab rd ON rd.definition_uid = ra.rank_definition_uid
       WHERE ra.member_uid = ?
       ORDER BY rd.sort_order ASC, ra.sequence_id ASC`,
      [uid]
    );

    const normalizedRows = normalizeRankDefinitions(rows);
    return rows.map((row, index) => {
      const definition = normalizedRows[index] || {};
      return {
        achievementUid:          row.achievement_uid,
        memberUid:               toNumber(row.member_uid),
        rankDefinitionUid:       row.rank_definition_uid,
        rank:                    toNumber(definition.rank),
        rankCode:                row.rank_code,
        rankName:                row.rank_name,
        pointsRequired:          toNumber(row.points_required),
        leftRankRequired:        toNumber(definition.left_rank_required  ?? row.left_rank_required),
        rightRankRequired:       toNumber(definition.right_rank_required ?? row.right_rank_required),
        incentiveSummary:        row.incentive_summary || '',
        cashIncentive:           toNumber(row.cash_incentive),
        achievedAt:              row.achieved_at,
        lastConsumedEventTs:     row.last_consumed_event_ts || row.achieved_at,
        sequenceId:              toNumber(row.sequence_id),
        grossPointsAtAchievement: toNumber(row.gross_points_at_achievement),
        remainingRankablePoints: toNumber(row.remaining_rankable_points),
        achievementStatus:       row.status,
        fulfilledAt:             row.fulfilled_at,
        adminFulfilledBy:        row.admin_fulfilled_by,
        fulfillmentNotes:        row.fulfillment_notes,
        sortOrder:               toNumber(row.sort_order),
      };
    });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return [];
    throw error;
  }
}

async function getConsumedEventMapForMember(uid, conn = pool) {
  try {
    const [rows] = await conn.query(
      `SELECT consumed_member_uid, source_event_id, COALESCE(SUM(points_consumed), 0) AS total_consumed
       FROM rank_point_consumptiontab
       WHERE consuming_member_uid = ?
       GROUP BY consumed_member_uid, source_event_id`,
      [uid]
    );

    const consumedByEvent = new Map();
    let consumedPoints = 0;

    for (const row of rows) {
      const key = `${toNumber(row.consumed_member_uid)}:${String(row.source_event_id || '')}`;
      const total = toNumber(row.total_consumed);
      consumedByEvent.set(key, total);
      consumedPoints += total;
    }

    return { consumedByEvent, consumedPoints };
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return { consumedByEvent: new Map(), consumedPoints: 0 };
    throw error;
  }
}

function buildRemainingEventPool(rankableEvents, consumedState) {
  const { consumedByEvent, consumedPoints } = consumedState;
  const grossRankablePoints = rankableEvents.reduce((sum, event) => sum + toNumber(event.points), 0);

  const remainingEvents = rankableEvents
    .map((event) => {
      const key = `${toNumber(event.sourceMemberUid)}:${String(event.sourceEventId || '')}`;
      const alreadyConsumed = toNumber(consumedByEvent.get(key));
      const remainingPoints = Math.max(0, toNumber(event.points) - alreadyConsumed);
      return { ...event, remainingPoints };
    })
    .filter((event) => toNumber(event.remainingPoints) > 0);

  return { grossRankablePoints, existingConsumedPoints: consumedPoints, remainingEvents };
}

async function getSubtreeQualifiedRankCounts(uid, rankDefinitions, conn = pool) {
  const [rows] = await conn.query(
    `SELECT c.leg,
            u.currentaccttype,
            GREATEST(COALESCE(r.highest_rank_no, 0), COALESCE(r.current_rank, 0), COALESCE(r.rank_level, 0)) AS awarded_rank
     FROM binary_tree_closuretab c
     INNER JOIN usertab u ON u.uid = c.descendant_uid
     LEFT JOIN rankingstab r ON r.uid = c.descendant_uid
     WHERE c.ancestor_uid = ?
       AND c.depth > 0`,
    [uid]
  );

  const thresholdCounts = new Map();
  for (const definition of rankDefinitions) {
    const threshold = Math.max(toNumber(definition.left_rank_required), toNumber(definition.right_rank_required));
    if (threshold > 0 && !thresholdCounts.has(threshold)) {
      thresholdCounts.set(threshold, { left: 0, right: 0 });
    }
  }

  for (const row of rows) {
    const leg = row.leg === 'left' ? 'left' : row.leg === 'right' ? 'right' : null;
    const awardedRank = clampRankToPackage(row.currentaccttype, row.awarded_rank);
    if (!leg || awardedRank <= 0) continue;
    for (const [threshold, counts] of thresholdCounts.entries()) {
      if (awardedRank >= threshold) counts[leg] += 1;
    }
  }

  const result = {};
  for (const definition of rankDefinitions) {
    const rankNo   = toNumber(definition.rank);
    const leftReq  = toNumber(definition.left_rank_required);
    const rightReq = toNumber(definition.right_rank_required);
    result[rankNo] = {
      leftQualifiedCount:  leftReq  > 0 ? toNumber(thresholdCounts.get(leftReq)?.left)  : 0,
      rightQualifiedCount: rightReq > 0 ? toNumber(thresholdCounts.get(rightReq)?.right) : 0,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

async function nextSequenceId(conn) {
  const [rows] = await conn.query(
    'SELECT next_sequence FROM rank_sequence_countertab WHERE id = 1 LIMIT 1 FOR UPDATE'
  );
  const next = toNumber(rows[0]?.next_sequence) || 1;
  await conn.query('UPDATE rank_sequence_countertab SET next_sequence = ? WHERE id = 1', [next + 1]);
  return next;
}

// ---------------------------------------------------------------------------
// Achievement insertion — writes both per-member and global consumption rows
// ---------------------------------------------------------------------------

async function insertAchievementAward(memberUid, award, definitionByRank, grossRankablePoints, conn) {
  const definition   = definitionByRank.get(toNumber(award.rank));
  const achievementUid = createPublicId();
  const sequenceId   = await nextSequenceId(conn);
  const achievedAt   = toMysqlDateTime(award.achievedAt) || nowMySQL();
  const lastConsumption = award.consumptionRows[award.consumptionRows.length - 1] || null;
  const remainingAfterAward = Math.max(0, toNumber(award.remainingRankablePointsAfterAward));

  await conn.query(
    `INSERT INTO rank_achievementstab
      (achievement_uid, member_uid, rank_definition_uid, achieved_at, last_consumed_event_ts,
       tie_break_member_uid, source_basis, sequence_id,
       gross_points_at_achievement, consumed_by_upline_points, remaining_rankable_points, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending_fulfillment')`,
    [
      achievementUid,
      memberUid,
      definition.definition_uid || null,
      achievedAt,
      achievedAt,
      toNumber(lastConsumption?.sourceMemberUid) || null,
      RACE_BASIS_MODE,
      sequenceId,
      toNumber(grossRankablePoints),
      remainingAfterAward,
    ]
  );

  rankLog('rank.achieved', {
    memberUid,
    rank:              award.rank,
    rankCode:          award.rankCode,
    grossPoints:       toNumber(grossRankablePoints),
    pointsConsumed:    award.pointsConsumed,
    remainingAfter:    remainingAfterAward,
    achievedAt,
    consumptionCount:  award.consumptionRows.length,
  });

  for (const row of award.consumptionRows) {
    // Per-member consumption ledger (audit trail for this achieving member)
    await conn.query(
      `INSERT INTO rank_point_consumptiontab
        (consumption_uid, consumed_member_uid, consuming_rank_uid, consuming_member_uid,
         points_consumed, source_event_id, source_event_ts, source_leg, source_process_id,
         consumed_at, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createPublicId(),
        toNumber(row.sourceMemberUid),
        achievementUid,
        memberUid,
        toNumber(row.pointsConsumed),
        toNumber(row.sourceEventId) || null,
        toMysqlDateTime(row.sourceEventTs),
        row.sourceLeg || 'unilevel',
        row.sourceProcessId || null,
        achievedAt,
        `${award.rankName} consumed ${toNumber(row.pointsConsumed)} repurchase pts from uid ${row.sourceMemberUid} (depth ${toNumber(row.sourceDepth)}).`,
      ]
    );

    // Global consumption — prevents ancestors from counting these same points.
    // Zero-out rule: once consumed here, the event is invisible to ancestor queries.
    if (toNumber(row.sourceEventId) > 0) {
      try {
        const [gcResult] = await conn.query(
          `INSERT IGNORE INTO rank_global_consumptiontab
             (repurchase_id, source_member_uid, consuming_member_uid, consuming_rank_uid, points_consumed)
           VALUES (?, ?, ?, ?, ?)`,
          [
            toNumber(row.sourceEventId),
            toNumber(row.sourceMemberUid),
            memberUid,
            achievementUid,
            toNumber(row.pointsConsumed),
          ]
        );
        // Phase-1 SHADOW: propagate this DEDUCTION up the source's sponsor chain so
        // the incremental aggregate stays correct (consumption drains uplines too).
        // GUARD: only when a NEW row was actually inserted (affectedRows === 1).
        // INSERT IGNORE skips duplicates on re-run; without this guard a rebuild
        // would double-deduct and silently drain uplines.
        if (gcResult.affectedRows === 1) {
          try {
            // eslint-disable-next-line global-require
            await require('./rankPoints').applyConsumptionDelta(conn, toNumber(row.sourceMemberUid), toNumber(row.pointsConsumed));
          } catch (shadowErr) {
            console.error('[RankPoints] shadow consumption propagate failed:', shadowErr.message);
          }
        }
      } catch (gcErr) {
        if (gcErr.code !== 'ER_NO_SUCH_TABLE') throw gcErr;
        // V023 not yet applied — global consumption not tracked; log a warning.
        console.warn(
          `[Ranking] rank_global_consumptiontab missing (run migrations). ` +
          `Rank ${award.rank} for uid ${memberUid} consumed ${toNumber(row.pointsConsumed)} pts ` +
          `from repurchase_id ${toNumber(row.sourceEventId)} without global zeroing.`
        );
      }
    }
  }

  rankLog('rank.consumption.written', {
    memberUid,
    achievementUid,
    rank:              award.rank,
    rowsConsumed:      award.consumptionRows.length,
    totalPointsZeroed: award.consumptionRows.reduce((s, r) => s + toNumber(r.pointsConsumed), 0),
  });

  return {
    achievementUid,
    rank:               toNumber(award.rank),
    rankCode:           award.rankCode,
    rankName:           award.rankName,
    cashIncentive:      toNumber(award.cashIncentive),
    achievedAt,
    achievementStatus:  'pending_fulfillment',
    remainingRankablePoints: remainingAfterAward,
  };
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function parseSnapshotRow(row) {
  const currentRank = Math.max(
    toNumber(row?.highest_rank_no),
    toNumber(row?.current_rank),
    toNumber(row?.rank_level)
  );
  return {
    currentRank,
    currentRankLabel:         currentRank > 0 ? (RANK_REQUIREMENTS[currentRank]?.label || `Rank ${currentRank}`) : 'Unranked',
    currentRankColor:         rankColor(currentRank),
    grossRankablePoints:      toNumber(row?.basis_points),
    consumedPoints:           toNumber(row?.consumed_points),
    remainingRankablePoints:  toNumber(row?.remaining_rankable_points),
    basisLabel:               row?.basis_label || RANKING_BASIS_LABEL,
    raceBasisMode:            row?.race_basis_mode || RACE_BASIS_MODE,
    rankDate:                 row?.rank_date || row?.qualified_date || null,
    raceLastAwardedAt:        row?.race_last_awarded_at || null,
    leftQualifiedCount:       toNumber(row?.left_qualified_count),
    rightQualifiedCount:      toNumber(row?.right_qualified_count),
    incentiveStatus:          toNumber(row?.incentive_status),
    rewardStatus:             toNumber(row?.reward_status),
    pendingAchievementCount:  toNumber(row?.pending_achievement_count),
    lastCalculatedAt:         row?.last_calculated_at || null,
  };
}

function buildPendingAchievementSummary(achievements = []) {
  const pending   = achievements.filter((a) => String(a.achievementStatus || a.status || '') === 'pending_fulfillment');
  const fulfilled = achievements.filter((a) => String(a.achievementStatus || a.status || '') === 'fulfilled');
  return {
    pendingCount:    pending.length,
    fulfilledCount:  fulfilled.length,
    nextPendingRank: pending[0] || null,
  };
}

function normalizeNextRankRequirement(definition) {
  if (!definition) return null;
  return {
    ...definition,
    rank:             toNumber(definition.rank),
    rankName:         definition.rankName || definition.rank_name || `Rank ${toNumber(definition.rank)}`,
    pointsRequired:   toNumber(definition.pointsRequired  ?? definition.points_required),
    leftRankRequired: toNumber(definition.leftRankRequired  ?? definition.left_rank_required),
    rightRankRequired: toNumber(definition.rightRankRequired ?? definition.right_rank_required),
  };
}

function applyPackageRankingGateToSnapshot(snapshot, packageType, definitions, achievements = []) {
  const policy = getPackageRankingPolicy(packageType);
  const effectiveDefinitions = filterRankDefinitionsForPackage(definitions, packageType);
  const filteredAchievements = (achievements || []).filter((a) =>
    canReleaseRankAchievementForPackage(packageType, a.rank)
  );
  const effectiveAchievementSummary = buildPendingAchievementSummary(filteredAchievements);
  const effectiveCurrentRankFromAchievements = filteredAchievements.length > 0
    ? Math.max(...filteredAchievements.map((a) => toNumber(a.rank)))
    : 0;

  const rawCurrentRank     = toNumber(snapshot.currentRank);
  const effectiveCurrentRank = Math.max(
    clampRankToPackage(packageType, rawCurrentRank),
    effectiveCurrentRankFromAchievements
  );
  const nextRankRequirement = normalizeNextRankRequirement(
    effectiveDefinitions.find((d) => toNumber(d.rank) > effectiveCurrentRank) || null
  );

  return {
    ...snapshot,
    rawCurrentRank,
    currentRank:               effectiveCurrentRank,
    currentRankLabel:          effectiveCurrentRank > 0 ? (RANK_REQUIREMENTS[effectiveCurrentRank]?.label || `Rank ${effectiveCurrentRank}`) : 'Unranked',
    currentRankColor:          rankColor(effectiveCurrentRank),
    nextRank:                  nextRankRequirement ? toNumber(nextRankRequirement.rank) : null,
    nextRankRequirement,
    leftRequirementMet:        !nextRankRequirement || toNumber(snapshot.leftQualifiedCount)  >= toNumber(nextRankRequirement.leftRankRequired),
    rightRequirementMet:       !nextRankRequirement || toNumber(snapshot.rightQualifiedCount) >= toNumber(nextRankRequirement.rightRankRequired),
    rankingEligible:           policy.rankingEligible,
    rankingEligibilityReason:  null,
    blockedByPackageGate:      false,
    packageType:               toNumber(packageType),
    packageLabel:              policy.packageLabel,
    packageRankMax:            policy.maxRank,
    packageRankMaxLabel:       policy.maxRankLabel,
    upgradeRequiredPackageType:  null,
    upgradeRequiredPackageLabel: null,
    achievements:              filteredAchievements,
    pendingAchievementCount:   effectiveAchievementSummary.pendingCount,
    nextPendingRank:           effectiveAchievementSummary.nextPendingRank,
    rankDefinitions:           effectiveDefinitions,
  };
}

async function getSnapshotRow(uid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT r.current_rank, r.rank_level, r.highest_rank_no, r.basis_points, r.consumed_points,
            remaining_rankable_points, basis_label, race_basis_mode,
            rank_date, race_last_awarded_at, qualified_date,
            left_qualified_count, right_qualified_count,
            incentive_status, reward_status, pending_achievement_count,
            last_calculated_at, u.currentaccttype
     FROM rankingstab r
     INNER JOIN usertab u ON u.uid = r.uid
     WHERE r.uid = ?
     LIMIT 1`,
    [uid]
  );
  return parseSnapshotRow(rows[0]);
}

async function upsertRankingSnapshot(uid, payload, conn) {
  await conn.query(
    `INSERT INTO rankingstab (
       uid, current_rank, rank_level, highest_rank_no, binary_points_total,
       basis_points, consumed_points, remaining_rankable_points,
       basis_label, race_basis_mode,
       left_qualified_count, right_qualified_count,
       rank_date, race_last_awarded_at, qualified_date,
       incentive_status, reward_status, pending_achievement_count,
       reward_claimed_date, last_calculated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       current_rank = VALUES(current_rank),
       rank_level   = VALUES(rank_level),
       highest_rank_no = VALUES(highest_rank_no),
       binary_points_total = VALUES(binary_points_total),
       basis_points = VALUES(basis_points),
       consumed_points = VALUES(consumed_points),
       remaining_rankable_points = VALUES(remaining_rankable_points),
       basis_label  = VALUES(basis_label),
       race_basis_mode = VALUES(race_basis_mode),
       left_qualified_count  = VALUES(left_qualified_count),
       right_qualified_count = VALUES(right_qualified_count),
       rank_date    = VALUES(rank_date),
       race_last_awarded_at = VALUES(race_last_awarded_at),
       qualified_date = VALUES(qualified_date),
       incentive_status = VALUES(incentive_status),
       reward_status    = VALUES(reward_status),
       pending_achievement_count = VALUES(pending_achievement_count),
       reward_claimed_date = VALUES(reward_claimed_date),
       last_calculated_at  = NOW()`,
    [
      uid,
      payload.currentRank,
      payload.currentRank,
      payload.currentRank,
      payload.binaryPoints,
      payload.grossRankablePoints,
      payload.consumedPoints,
      payload.remainingRankablePoints,
      payload.basisLabel,
      payload.raceBasisMode,
      payload.leftQualifiedCount,
      payload.rightQualifiedCount,
      payload.rankDate,
      payload.raceLastAwardedAt,
      payload.rankDate,
      payload.incentiveStatus,
      payload.rewardStatus,
      payload.pendingAchievementCount,
      payload.rewardClaimedDate,
    ]
  );
}

// ---------------------------------------------------------------------------
// Core rebuild — processes sponsor children BEFORE parent (bottom-up DFS)
// ---------------------------------------------------------------------------

async function rebuildRankSnapshot(uid, conn = pool, context = null) {
  await ensureRankingTable(conn);

  const memberUid = toNumber(uid);
  const ctx = context || { memo: new Map(), stack: new Set(), definitions: null };

  if (ctx.memo.has(memberUid))  return ctx.memo.get(memberUid);
  if (ctx.stack.has(memberUid)) return ctx.memo.get(memberUid) || null;
  ctx.stack.add(memberUid);

  try {
    const definitions = ctx.definitions || await getRankDefinitions(conn);
    ctx.definitions = definitions;

    // Flagged (company/system) accounts must never rank → never consume network
    // repurchase points. Load the excluded set once per rebuild (shared via ctx).
    if (!ctx.excludedSet) ctx.excludedSet = await loadExcludedSet(conn);

    const [memberRows] = await conn.query(
      'SELECT currentaccttype FROM usertab WHERE uid = ? LIMIT 1',
      [memberUid]
    );
    const packageType          = toNumber(memberRows[0]?.currentaccttype);
    const effectiveDefinitions = filterRankDefinitionsForPackage(definitions, packageType);
    const definitionByRank     = new Map(definitions.map((d) => [toNumber(d.rank), d]));

    // --- BOTTOM-UP: process all direct sponsor children before this member ---
    const sponsorChildren = await getSponsorChildren(memberUid, conn);
    rankLog('rank.rebuild.start', {
      memberUid,
      packageType,
      sponsorChildCount: sponsorChildren.length,
    });

    for (const childUid of sponsorChildren) {
      await rebuildRankSnapshot(childUid, conn, ctx);
    }

    // --- Collect rankable events from this member's sponsor tree downline ---
    const rankableEvents    = await listRankableEventsForMember(memberUid, conn);
    const achievementsBefore = await getAchievementRowsForMember(memberUid, conn);
    const consumedState     = await getConsumedEventMapForMember(memberUid, conn);
    const eventPool         = buildRemainingEventPool(rankableEvents, consumedState);
    const subtreeQualifiedRankCounts = await getSubtreeQualifiedRankCounts(memberUid, effectiveDefinitions, conn);

    rankLog('rank.points.collected', {
      memberUid,
      sponsorTreeEvents:    rankableEvents.length,
      grossRankablePoints:  eventPool.grossRankablePoints,
      existingConsumed:     eventPool.existingConsumedPoints,
      remainingEvents:      eventPool.remainingEvents.length,
    });

    const raceState = computeRankAwardsFromEvents({
      memberUid,
      rankDefinitions:           effectiveDefinitions,
      rankableEvents:            eventPool.remainingEvents,
      subtreeQualifiedRankCounts,
      existingAchievements:      achievementsBefore,
      grossRankablePoints:       eventPool.grossRankablePoints,
      consumedPoints:            eventPool.existingConsumedPoints,
    });

    // GUARD: a flagged account never achieves a rank, so it never writes a
    // consumption row — its downline's repurchase points stay available to real
    // members. Zero the awards before the insert loop below.
    const rankExcluded = ctx.excludedSet.has(memberUid);
    if (rankExcluded) raceState.awards = [];

    if (raceState.awards.length > 0) {
      rankLog('rank.new.awards', {
        memberUid,
        newAwards: raceState.awards.map((a) => ({
          rank:     a.rank,
          rankCode: a.rankCode,
          points:   a.pointsConsumed,
          rows:     a.consumptionRows.length,
        })),
      });

      let rollingConsumedPoints = eventPool.existingConsumedPoints;
      for (const award of raceState.awards) {
        rollingConsumedPoints += toNumber(award.pointsConsumed);
        award.remainingRankablePointsAfterAward = Math.max(
          0, raceState.grossRankablePoints - rollingConsumedPoints
        );
        await insertAchievementAward(memberUid, award, definitionByRank, raceState.grossRankablePoints, conn);
      }
    }

    const achievementsAfter = await getAchievementRowsForMember(memberUid, conn);
    const filteredAchievements = achievementsAfter.filter((a) =>
      canReleaseRankAchievementForPackage(packageType, a.rank)
    );
    const achievementSummary = summarizeAchievementStatus(filteredAchievements);
    const pairing   = await getLatestPairingSnapshot(memberUid, conn);
    const latestAward = [...filteredAchievements].sort((a, b) => toNumber(a.rank) - toNumber(b.rank)).at(-1) || null;
    const nextRankDefinition = raceState.nextRankRequirement;
    const nextCounts = nextRankDefinition ? (subtreeQualifiedRankCounts[toNumber(nextRankDefinition.rank)] || {}) : {};
    const currentRank = filteredAchievements.length > 0
      ? Math.max(...filteredAchievements.map((a) => toNumber(a.rank)))
      : 0;

    // Display basis fix (V023 rule #3). rank_global_consumptiontab nets BOTH this
    // member's OWN consumption and deeper members' consumption out of the event
    // pool. Deeper-member netting is correct (prevents double-count up the chain),
    // but the member's own consumption must not be removed from GROSS and then
    // subtracted AGAIN as CONSUMED — that floored REMAINING to 0 for ranked members
    // (e.g. Supervisor-1 with 13,690 verified, 10,000 consumed showing 0 instead of
    // 3,690). Add the member's already-global own consumption back into the displayed
    // gross so GROSS = rawDownline - others_consumed and REMAINING = GROSS - own.
    // Award gating is untouched — it uses the event pool, not these display figures.
    const { displayGross, displayRemaining } = computeDisplayBasis(raceState);
    // An excluded account never actually consumes — its awards were zeroed above and no
    // global consumption row is written. Its HYPOTHETICAL consumedPoints must not linger
    // in the snapshot (it would understate REMAINING and show as reconciliation drift).
    // Present a full, un-consumed pool: consumed = 0, remaining = gross.
    const snapshotConsumed  = rankExcluded ? 0 : raceState.consumedPoints;
    const snapshotRemaining = rankExcluded ? displayGross : displayRemaining;

    const snapshotPayload = {
      currentRank,
      grossRankablePoints:      displayGross,
      consumedPoints:           snapshotConsumed,
      remainingRankablePoints:  snapshotRemaining,
      basisLabel:               RANKING_BASIS_LABEL,
      raceBasisMode:            RACE_BASIS_MODE,
      binaryPoints:             pairing.binaryPoints,
      leftQualifiedCount:       toNumber(nextCounts.leftQualifiedCount),
      rightQualifiedCount:      toNumber(nextCounts.rightQualifiedCount),
      rankDate:                 latestAward?.achievedAt ? toMysqlDateTime(latestAward.achievedAt) : null,
      raceLastAwardedAt:        latestAward?.achievedAt ? toMysqlDateTime(latestAward.achievedAt) : null,
      incentiveStatus:          achievementSummary.pendingCount > 0 ? 0 : (currentRank > 0 ? 1 : 0),
      rewardStatus:             achievementSummary.pendingCount > 0 ? 0 : (currentRank > 0 ? 1 : 0),
      pendingAchievementCount:  achievementSummary.pendingCount,
      rewardClaimedDate:        achievementSummary.pendingCount > 0
        ? null
        : (latestAward?.fulfilledAt ? toMysqlDateTime(latestAward.fulfilledAt) : null),
    };

    await upsertRankingSnapshot(memberUid, snapshotPayload, conn);

    rankLog('rank.snapshot.saved', {
      memberUid,
      currentRank,
      grossRankablePoints:     snapshotPayload.grossRankablePoints,
      consumedPoints:          snapshotPayload.consumedPoints,
      remainingRankablePoints: snapshotPayload.remainingRankablePoints,
    });

    const snapshot = {
      uid: memberUid,
      currentRank,
      currentRankLabel:         currentRank > 0 ? (RANK_REQUIREMENTS[currentRank]?.label || `Rank ${currentRank}`) : 'Unranked',
      currentRankColor:         rankColor(currentRank),
      grossRankablePoints:      displayGross,
      consumedPoints:           snapshotConsumed,
      remainingRankablePoints:  snapshotRemaining,
      basisPoints:              displayGross,
      basisLabel:               RANKING_BASIS_LABEL,
      raceBasisMode:            RACE_BASIS_MODE,
      rankDate:                 snapshotPayload.rankDate,
      raceLastAwardedAt:        snapshotPayload.raceLastAwardedAt,
      leftQualifiedCount:       toNumber(nextCounts.leftQualifiedCount),
      rightQualifiedCount:      toNumber(nextCounts.rightQualifiedCount),
      leftRequirementMet:       raceState.leftRequirementMet,
      rightRequirementMet:      raceState.rightRequirementMet,
      nextRank:                 raceState.nextRank,
      nextRankRequirement:      raceState.nextRankRequirement,
      achievements:             filteredAchievements,
      pendingAchievementCount:  achievementSummary.pendingCount,
      nextPendingRank:          achievementSummary.nextPendingRank,
      incentiveStatus:          snapshotPayload.incentiveStatus,
      rewardStatus:             snapshotPayload.rewardStatus,
      pairing,
    };

    const gatedSnapshot = applyPackageRankingGateToSnapshot(snapshot, packageType, definitions, filteredAchievements);
    ctx.memo.set(memberUid, gatedSnapshot);
    return gatedSnapshot;
  } finally {
    ctx.stack.delete(memberUid);
  }
}

// ---------------------------------------------------------------------------
// shouldRefreshRankState + stored row helpers
// ---------------------------------------------------------------------------

function shouldRefreshRankState(row) {
  if (!row || !row.last_calculated_at) return true;
  const lastCalc = new Date(row.last_calculated_at);
  if (Number.isNaN(lastCalc.getTime())) return true;
  const ageMs = Date.now() - lastCalc.getTime();
  if (ageMs > RANK_REFRESH_MAX_AGE_MINUTES * 60 * 1000) return true;
  if (toNumber(row.highest_rank_no || row.current_rank || row.rank_level) > 0
      && !(row.rank_date || row.qualified_date || row.race_last_awarded_at)) return true;
  return false;
}

async function getStoredRankingRow(uid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT r.uid, r.current_rank, r.rank_level, r.highest_rank_no, r.basis_points, r.consumed_points,
            remaining_rankable_points, basis_label, race_basis_mode, left_qualified_count,
            right_qualified_count, rank_date, qualified_date, race_last_awarded_at,
            incentive_status, reward_status, pending_achievement_count, reward_claimed_date,
            last_calculated_at, u.currentaccttype
     FROM rankingstab r
     INNER JOIN usertab u ON u.uid = r.uid
     WHERE r.uid = ?
     LIMIT 1`,
    [uid]
  );
  return rows[0] || null;
}

function buildSnapshotFromStoredRow(row, definitions, pairing, achievements = []) {
  const currentRank = Math.max(
    toNumber(row?.highest_rank_no),
    toNumber(row?.current_rank),
    toNumber(row?.rank_level)
  );
  const nextRankRequirement   = definitions.find((d) => toNumber(d.rank) > currentRank) || null;
  const leftQualifiedCount    = toNumber(row?.left_qualified_count);
  const rightQualifiedCount   = toNumber(row?.right_qualified_count);

  const snapshot = {
    uid:                     toNumber(row?.uid),
    currentRank,
    currentRankLabel:        currentRank > 0 ? (RANK_REQUIREMENTS[currentRank]?.label || `Rank ${currentRank}`) : 'Unranked',
    currentRankColor:        rankColor(currentRank),
    grossRankablePoints:     toNumber(row?.basis_points),
    consumedPoints:          toNumber(row?.consumed_points),
    remainingRankablePoints: toNumber(row?.remaining_rankable_points),
    basisPoints:             toNumber(row?.basis_points),
    basisLabel:              row?.basis_label || RANKING_BASIS_LABEL,
    raceBasisMode:           row?.race_basis_mode || RACE_BASIS_MODE,
    rankDate:                row?.race_last_awarded_at || row?.rank_date || row?.qualified_date || null,
    raceLastAwardedAt:       row?.race_last_awarded_at || row?.rank_date || row?.qualified_date || null,
    leftQualifiedCount,
    rightQualifiedCount,
    leftRequirementMet:  !nextRankRequirement || leftQualifiedCount  >= toNumber(nextRankRequirement.left_rank_required),
    rightRequirementMet: !nextRankRequirement || rightQualifiedCount >= toNumber(nextRankRequirement.right_rank_required),
    nextRank:            nextRankRequirement ? toNumber(nextRankRequirement.rank) : null,
    nextRankRequirement,
    achievements,
    pendingAchievementCount: toNumber(row?.pending_achievement_count),
    nextPendingRank:         achievements.find((a) => a.achievementStatus !== 'paid') || null,
    incentiveStatus:         toNumber(row?.incentive_status),
    rewardStatus:            toNumber(row?.reward_status),
    pairing,
  };

  return applyPackageRankingGateToSnapshot(snapshot, row?.currentaccttype, definitions, achievements);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function refreshMemberRankSnapshot(uid) {
  const memberUid = toNumber(uid);
  if (memberRefreshPromises.has(memberUid)) return memberRefreshPromises.get(memberUid);

  const refreshPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await rebuildRankSnapshot(memberUid, conn);
      await conn.commit();
      return snapshot;
    } catch (error) {
      try { await conn.rollback(); } catch {}
      throw error;
    } finally {
      conn.release();
    }
  })();

  memberRefreshPromises.set(memberUid, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    memberRefreshPromises.delete(memberUid);
  }
}

async function getCurrentRank(uid) {
  await ensureRankingInfra();
  const storedRow = await getStoredRankingRow(toNumber(uid));
  return toNumber(storedRow?.current_rank || storedRow?.rank_level || 0);
}

async function getRankProgress(uid) {
  await ensureRankingInfra();
  const memberUid  = toNumber(uid);
  const definitions = await getRankDefinitions();
  const storedRow  = await getStoredRankingRow(memberUid);

  // Never trigger a rebuild inline — reads always use the stored snapshot.
  // Rebuilds are fired in the background after code activations (codes.js).
  let snapshot;
  if (storedRow) {
    const [pairing, achievements] = await Promise.all([
      getLatestPairingSnapshot(memberUid),
      getAchievementRowsForMember(memberUid),
    ]);
    snapshot = buildSnapshotFromStoredRow(storedRow, definitions, pairing, achievements);
  } else {
    snapshot = await refreshMemberRankSnapshot(memberUid);
  }

  const progress = !snapshot.rankingEligible
    ? 0
    : snapshot.nextRankRequirement
    ? Math.min(100, (toNumber(snapshot.remainingRankablePoints) / toNumber(snapshot.nextRankRequirement.pointsRequired || 0)) * 100)
    : 100;

  const achievementsByRank = new Map(snapshot.achievements.map((a) => [toNumber(a.rank), a]));
  const effectiveDefinitions = snapshot.rankDefinitions || filterRankDefinitionsForPackage(definitions, snapshot.packageType);

  return {
    uid: memberUid,
    packageType:              snapshot.packageType,
    packageLabel:             snapshot.packageLabel,
    rankingEligible:          snapshot.rankingEligible,
    rankingEligibilityReason: snapshot.rankingEligibilityReason,
    blockedByPackageGate:     snapshot.blockedByPackageGate,
    packageRankMax:           snapshot.packageRankMax,
    packageRankMaxLabel:      snapshot.packageRankMaxLabel,
    upgradeRequiredPackageType:  snapshot.upgradeRequiredPackageType,
    upgradeRequiredPackageLabel: snapshot.upgradeRequiredPackageLabel,
    currentRank:              snapshot.currentRank,
    currentRankLabel:         snapshot.currentRankLabel,
    currentRankColor:         snapshot.currentRankColor,
    basisLabel:               snapshot.basisLabel,
    basisPoints:              snapshot.basisPoints,
    grossRankablePoints:      snapshot.grossRankablePoints,
    consumedPoints:           snapshot.consumedPoints,
    remainingRankablePoints:  snapshot.remainingRankablePoints,
    repurchasePoints:         snapshot.grossRankablePoints,
    binaryPoints:             snapshot.pairing.binaryPoints,
    qualifiedDate:            snapshot.rankDate,
    nextRank:                 snapshot.nextRank,
    nextRankLabel:            snapshot.nextRankRequirement?.rankName || 'Max Rank Achieved',
    nextRankMinPoints:        snapshot.nextRankRequirement?.pointsRequired || null,
    nextRankRequirement:      snapshot.nextRankRequirement,
    leftRequirementMet:       snapshot.leftRequirementMet,
    rightRequirementMet:      snapshot.rightRequirementMet,
    progress:                 Number.isFinite(progress) ? Math.round(progress * 100) / 100 : 0,
    left: {
      count:          snapshot.pairing.leftCount,
      points:         snapshot.pairing.leftPoints,
      qualifiedCount: snapshot.leftQualifiedCount,
    },
    right: {
      count:          snapshot.pairing.rightCount,
      points:         snapshot.pairing.rightPoints,
      qualifiedCount: snapshot.rightQualifiedCount,
    },
    achievements: snapshot.achievements.map((a) => ({
      rank:             toNumber(a.rank),
      rankCode:         a.rankCode,
      rankName:         a.rankName,
      achievedAt:       a.achievedAt,
      status:           a.achievementStatus,
      cashIncentive:    a.cashIncentive,
      incentiveSummary: a.incentiveSummary,
      fulfilledAt:      a.fulfilledAt,
    })),
    pendingAchievementCount: snapshot.pendingAchievementCount,
    nextPendingRank:         snapshot.nextPendingRank,
    incentiveStatus:         snapshot.incentiveStatus,
    rewardStatus:            snapshot.rewardStatus,
    incentives:              snapshot.nextPendingRank?.incentiveSummary || snapshot.achievements.at(-1)?.incentiveSummary || 'N/A',
    rankDefinitions:         effectiveDefinitions,
    ranks:                   effectiveDefinitions.map((definition) => {
      const achievement = achievementsByRank.get(toNumber(definition.rank));
      return {
        rank:         toNumber(definition.rank),
        label:        definition.rank_name,
        minPoints:    toNumber(definition.points_required),
        qualified:    Boolean(achievement),
        qualifiedDate: achievement?.achievedAt || null,
        status:       achievement?.achievementStatus || 'locked',
      };
    }),
  };
}

async function getCurrentRankMap(uidList, conn = pool) {
  if (!uidList || uidList.length === 0) return new Map();
  const uniqueIds = [...new Set(uidList.map((id) => toNumber(id)).filter((id) => id > 0))];
  if (uniqueIds.length === 0) return new Map();

  const placeholders = uniqueIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT uid, GREATEST(COALESCE(highest_rank_no, 0), COALESCE(current_rank, 0), COALESCE(rank_level, 0)) AS rank_no
     FROM rankingstab WHERE uid IN (${placeholders})`,
    uniqueIds
  );
  const rankMap = new Map();
  for (const row of rows) rankMap.set(toNumber(row.uid), toNumber(row.rank_no));
  return rankMap;
}

/**
 * Refresh the entire ranking forest starting from sponsor-tree roots.
 * Root = a member whose drefid points to no valid other member (top of sponsor chain).
 * Processing is bottom-up because rebuildRankSnapshot recurses into sponsor children first.
 */
async function refreshRankingForest() {
  await ensureRankingInfra();

  // Find sponsor-tree roots: members whose drefid doesn't resolve to another member.
  const [rootRows] = await pool.query(
    `SELECT u.uid
     FROM usertab u
     LEFT JOIN usertab parent ON parent.uid = u.drefid AND parent.uid != u.uid AND parent.uid > 0
     WHERE parent.uid IS NULL AND u.uid > 0
     ORDER BY u.uid ASC`
  );

  const roots = rootRows.map((row) => toNumber(row.uid)).filter((v) => v > 0);
  rankLog('rank.forest.refresh.start', { rootCount: roots.length });

  for (const rootUid of roots) {
    await refreshMemberRankSnapshot(rootUid);
  }

  rankLog('rank.forest.refresh.done', { rootCount: roots.length });
}

async function getAllRankings(page = 1, perPage = 30) {
  await ensureRankingInfra();
  const definitions = await getRankDefinitions();

  // Hide flagged/excluded accounts from the leaderboard entirely ("treat as if
  // they never existed"). They also never earn or consume — the engine already
  // zeroes their awards before any consumption (loadExcludedSet at the rebuild
  // path). Detached accounts get hidden the same way once flagged-excluded.
  const excludedUids = [...await loadExcludedSet()].filter((v) => v > 0);
  const exclusionSql = excludedUids.length
    ? `AND u.uid NOT IN (${excludedUids.map(() => '?').join(',')})`
    : '';

  const currentPage = Math.max(1, Number(page) || 1);
  const size   = Math.min(100, Math.max(1, Number(perPage) || 30));
  const offset = (currentPage - 1) * size;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM usertab u WHERE u.uid = u.mainid ${exclusionSql}`,
    excludedUids
  );
  const total = toNumber(countRows[0]?.total);

  const [rows] = await pool.query(
    `SELECT
        u.uid,
        u.currentaccttype,
        m.firstname,
        m.lastname,
        m.username,
        COALESCE(r.current_rank, 0) AS current_rank,
        COALESCE(r.rank_level, 0) AS rank_level,
        COALESCE(r.highest_rank_no, 0) AS highest_rank_no,
        COALESCE(r.basis_points, 0) AS basis_points,
        COALESCE(r.consumed_points, 0) AS consumed_points,
        COALESCE(r.remaining_rankable_points, 0) AS remaining_rankable_points,
        COALESCE(r.pending_achievement_count, 0) AS pending_achievement_count,
        r.basis_label,
        r.rank_date,
        r.qualified_date,
        r.race_last_awarded_at,
        r.last_calculated_at,
        COALESCE(r.incentive_status, 0) AS incentive_status,
        COALESCE(r.reward_status, 0) AS reward_status
     FROM usertab u
     INNER JOIN memberstab m ON m.uid = u.uid
     LEFT JOIN rankingstab r ON r.uid = u.uid
     WHERE u.uid = u.mainid ${exclusionSql}
     ORDER BY
       GREATEST(COALESCE(r.highest_rank_no,0), COALESCE(r.current_rank,0), COALESCE(r.rank_level,0)) DESC,
       (COALESCE(r.consumed_points,0) + COALESCE(r.remaining_rankable_points,0)) DESC,
       COALESCE(r.race_last_awarded_at, r.rank_date, r.qualified_date, '9999-12-31 23:59:59') ASC,
       u.uid ASC
     LIMIT ?, ?`,
    [...excludedUids, offset, size]
  );

  // Validate repurchase points via sponsor tree for each listed member.
  const listedUids = rows.map((r) => toNumber(r.uid)).filter((v) => v > 0);
  const repurchaseValidation = new Map();
  if (listedUids.length > 0) {
    try {
      const uidPlaceholders = listedUids.map(() => '?').join(',');
      // Use sponsor tree (drefid) for validation, not binary closure
      const [rpRows] = await pool.query(
        `WITH RECURSIVE sponsor_trees AS (
           SELECT uid AS ancestor_uid, uid, 0 AS depth
           FROM usertab
           WHERE uid IN (${uidPlaceholders})
           UNION ALL
           SELECT st.ancestor_uid, u.uid, st.depth + 1
           FROM usertab u
           INNER JOIN sponsor_trees st ON u.drefid = st.uid AND u.uid <> st.uid
           WHERE st.depth < 30
         )
         SELECT
             st.ancestor_uid AS member_uid,
             COUNT(DISTINCT r.uid) AS contributor_count,
             COUNT(*) AS repurchase_events,
             COALESCE(SUM(r.incentivepoints1), 0) AS total_points,
             MAX(r.transdate) AS last_repurchase_date
           FROM repurchasetab r
           INNER JOIN sponsor_trees st ON st.uid = r.uid AND st.depth > 0
           WHERE COALESCE(r.incentivepoints1, 0) > 0
           GROUP BY st.ancestor_uid`,
        listedUids
      );
      for (const rpRow of rpRows) {
        repurchaseValidation.set(toNumber(rpRow.member_uid), {
          contributorCount:    toNumber(rpRow.contributor_count),
          repurchaseEvents:    toNumber(rpRow.repurchase_events),
          verifiedPoints:      toNumber(rpRow.total_points),
          lastRepurchaseDate:  rpRow.last_repurchase_date || null,
        });
      }
    } catch (rpErr) {
      // Non-fatal: skip validation on error
    }
  }

  const hydrated = [];
  for (const row of rows) {
    const rpData = repurchaseValidation.get(toNumber(row.uid)) || {
      contributorCount: 0, repurchaseEvents: 0, verifiedPoints: 0, lastRepurchaseDate: null,
    };
    const snapshot = applyPackageRankingGateToSnapshot({
      currentRank:             Math.max(toNumber(row.highest_rank_no), toNumber(row.current_rank), toNumber(row.rank_level)),
      currentRankLabel:        RANK_REQUIREMENTS[Math.max(toNumber(row.highest_rank_no), toNumber(row.current_rank), toNumber(row.rank_level))]?.label || 'Unranked',
      currentRankColor:        rankColor(Math.max(toNumber(row.highest_rank_no), toNumber(row.current_rank), toNumber(row.rank_level))),
      grossRankablePoints:     toNumber(row.basis_points),
      consumedPoints:          toNumber(row.consumed_points),
      remainingRankablePoints: toNumber(row.remaining_rankable_points),
      basisLabel:              row.basis_label || RANKING_BASIS_LABEL,
      rankDate:                row.race_last_awarded_at || row.rank_date || row.qualified_date || null,
      pendingAchievementCount: toNumber(row.pending_achievement_count),
      incentiveStatus:         toNumber(row.incentive_status),
      rewardStatus:            toNumber(row.reward_status),
      nextPendingRank:         null,
      leftQualifiedCount:      0,
      rightQualifiedCount:     0,
      achievements:            [],
      pairing:                 { binaryPoints: 0, leftCount: 0, rightCount: 0, leftPoints: 0, rightPoints: 0 },
    }, row.currentaccttype, definitions, []);

    hydrated.push({
      uid:                     toNumber(row.uid),
      firstname:               row.firstname,
      lastname:                row.lastname,
      username:                row.username,
      packageType:             toNumber(row.currentaccttype),
      packageLabel:            snapshot.packageLabel,
      rankingEligible:         snapshot.rankingEligible,
      rankingEligibilityReason: snapshot.rankingEligibilityReason,
      blockedByPackageGate:    snapshot.blockedByPackageGate,
      packageRankMax:          snapshot.packageRankMax,
      packageRankMaxLabel:     snapshot.packageRankMaxLabel,
      upgradeRequiredPackageType:  snapshot.upgradeRequiredPackageType,
      upgradeRequiredPackageLabel: snapshot.upgradeRequiredPackageLabel,
      current_rank:            snapshot.currentRank,
      currentRank:             snapshot.currentRank,
      rankLabel:               snapshot.currentRankLabel,
      currentRankLabel:        snapshot.currentRankLabel,
      rankColor:               snapshot.currentRankColor,
      basisPoints:             snapshot.grossRankablePoints,
      grossRankablePoints:     snapshot.grossRankablePoints,
      consumedPoints:          snapshot.consumedPoints,
      remainingRankablePoints: snapshot.remainingRankablePoints,
      repurchasePoints:        snapshot.grossRankablePoints,
      pendingAchievementCount: snapshot.pendingAchievementCount,
      qualifiedDate:           snapshot.rankDate,
      rank_date:               snapshot.rankDate,
      incentive_status:        snapshot.incentiveStatus,
      reward_status:           snapshot.rewardStatus,
      repurchaseContributorCount: rpData.contributorCount,
      repurchaseEvents:        rpData.repurchaseEvents,
      verifiedRepurchasePoints: rpData.verifiedPoints,
      lastRepurchaseDate:      rpData.lastRepurchaseDate,
    });
  }

  hydrated.sort((a, b) => {
    // Highest rank first, then biggest TOTAL accumulated (consumed + remaining) —
    // ranking up consumes points to ~0 remaining, so total keeps the highest-rank
    // biggest-network member at the top instead of burying it. Mirrors the SQL.
    const rankDiff = toNumber(b.currentRank) - toNumber(a.currentRank);
    if (rankDiff !== 0) return rankDiff;
    const totalA = toNumber(a.consumedPoints) + toNumber(a.remainingRankablePoints);
    const totalB = toNumber(b.consumedPoints) + toNumber(b.remainingRankablePoints);
    if (totalB !== totalA) return totalB - totalA;
    const dateCompare = dateSortValue(a.qualifiedDate) - dateSortValue(b.qualifiedDate);
    if (dateCompare !== 0) return dateCompare;
    return toNumber(a.uid) - toNumber(b.uid);
  });

  hydrated.forEach((row, index) => { row.position = offset + index + 1; });

  return { rankings: hydrated, total, page: currentPage, totalPages: Math.max(1, Math.ceil(total / size)), perPage: size };
}

async function getRankCashIncentive(rankOrCode, conn = pool) {
  const rankNo   = toNumber(rankOrCode);
  const fallback = rankNo > 0
    ? (RANK_CASH_INCENTIVES[rankNo] || 0)
    : (FULL_RANK_DEFINITIONS.find((r) => r.rank_code === String(rankOrCode || '').toLowerCase())?.cash_incentive || 0);

  try {
    if (rankNo > 0) {
      const definitions = await getRankDefinitions(conn);
      const match = definitions.find((d) => toNumber(d.rank) === rankNo);
      return toNumber(match?.cash_incentive) || fallback;
    }
    const [rows] = await conn.query(
      `SELECT cash_incentive FROM rank_definitionstab
       WHERE rank_code = ? AND is_active = 1
       ORDER BY version DESC, sort_order ASC LIMIT 1`,
      [String(rankOrCode || '').toLowerCase()]
    );
    return toNumber(rows[0]?.cash_incentive) || fallback;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') return fallback;
    throw error;
  }
}

async function processIncentive(uid, options = {}) {
  await ensureRankingTable();
  const memberUid = toNumber(uid);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT ra.id, ra.achievement_uid, ra.member_uid, ra.status,
              rd.rank_code, rd.rank_name, rd.cash_incentive, rd.incentive_summary, rd.sort_order
       FROM rank_achievementstab ra
       INNER JOIN rank_definitionstab rd ON rd.definition_uid = ra.rank_definition_uid
       WHERE ra.member_uid = ? AND ra.status = 'pending_fulfillment'
       ORDER BY rd.sort_order ASC, ra.sequence_id ASC LIMIT 1 FOR UPDATE`,
      [memberUid]
    );

    const pending = rows[0];
    if (!pending) {
      await conn.rollback();
      return { success: false };
    }

    const [memberRows] = await conn.query(
      'SELECT currentaccttype FROM usertab WHERE uid = ? LIMIT 1 FOR UPDATE', [memberUid]
    );
    const packageType  = toNumber(memberRows[0]?.currentaccttype);
    const definitions  = await getRankDefinitions(conn);
    const pendingRank  = definitions.find((d) => d.rank_code === pending.rank_code)?.rank || 0;

    if (!canReleaseRankAchievementForPackage(packageType, pendingRank)) {
      await conn.rollback();
      return { success: false, error: 'Ranking claim is blocked by the member package gate.' };
    }

    const cashIncentive = toNumber(pending.cash_incentive);
    const processKey    = createProcessKey(['ranking-bonus', memberUid, pending.achievement_uid]);
    const now           = nowMySQL();
    let beginningBalance = 0;
    let endingBalance    = 0;

    if (cashIncentive > 0) {
      const [walletRows] = await conn.query(
        'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE', [memberUid]
      );
      beginningBalance = toNumber(walletRows[0]?.ttlcashbalance);
      endingBalance    = beginningBalance + cashIncentive;

      await conn.query(
        `INSERT INTO payouthistorytab
         (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
          income1, income2, income3, income4, income5, income6,
          income7, income8, income9, income10,
          encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
          cashstatus, transdate, transactiontype, stockistid, processid)
         VALUES (NULL, ?, NULL, ?, ?, 0, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, 1, 0, ?)`,
        [memberUid, beginningBalance, endingBalance, cashIncentive, now, processKey]
      );

      await conn.query(
        `INSERT INTO payouttotaltab
         (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome51, ttlincome6,
          ttlcashbalance, ttlpointsbalance, transdate)
         VALUES (?, NULL, 0, 0, 0, 0, 0, 0, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
          ttlincome6    = ttlincome6 + VALUES(ttlincome6),
          ttlcashbalance = VALUES(ttlcashbalance),
          transdate      = VALUES(transdate)`,
        [memberUid, cashIncentive, endingBalance, now]
      );

      try {
        await conn.query(
          `INSERT INTO income_eventstab
           (event_uid, process_key, beneficiary_uid, income_type, source_ref_uid, source_ref_type,
            gross_amount, tax_deduction, processing_fee, cd_deduction, maintenance_fee,
            net_amount, status, credited_at)
           VALUES (?, ?, ?, 'ranking_bonus', ?, 'rank_achievementstab', ?, 0, 0, 0, 0, ?, 'credited', CURRENT_TIMESTAMP(6))`,
          [createPublicId(), processKey, memberUid, pending.achievement_uid, cashIncentive, cashIncentive]
        );
      } catch (ledgerError) {
        if (ledgerError.code !== 'ER_NO_SUCH_TABLE') throw ledgerError;
      }
    }

    await conn.query(
      `UPDATE rank_achievementstab
          SET status = 'fulfilled', fulfilled_at = NOW(),
              admin_fulfilled_by = ?, fulfillment_notes = ?
        WHERE achievement_uid = ?`,
      [
        Number(options.adminUid) || null,
        cashIncentive > 0
          ? `Released ranking bonus cash via ${processKey}`
          : 'Marked fulfilled without cash incentive.',
        pending.achievement_uid,
      ]
    );

    const [pendingCountRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM rank_achievementstab
       WHERE member_uid = ? AND status = 'pending_fulfillment'`,
      [memberUid]
    );
    const pendingCount = toNumber(pendingCountRows[0]?.total);

    await conn.query(
      `UPDATE rankingstab SET incentive_status = ?, reward_status = ?,
              pending_achievement_count = ?, reward_claimed_date = NOW()
        WHERE uid = ?`,
      [pendingCount > 0 ? 0 : 1, pendingCount > 0 ? 0 : 1, pendingCount, memberUid]
    );

    await writeAuditLog(conn, {
      req:       options.req,
      actorUid:  Number(options.adminUid) || null,
      actorRole: 'admin',
      action:    'ranking.incentive.process',
      targetUid: memberUid,
      targetTable: 'rank_achievementstab',
      targetId:  pending.achievement_uid,
      afterState: {
        rankCode: pending.rank_code, rankName: pending.rank_name,
        cashIncentive, beginningBalance, endingBalance,
        processKey, pendingCountAfter: pendingCount,
      },
    });

    rankLog('rank.incentive.released', {
      memberUid,
      rankCode:      pending.rank_code,
      cashIncentive,
      beginningBalance,
      endingBalance,
      pendingCountAfter: pendingCount,
    });

    await conn.commit();
    return {
      success:         true,
      rankCode:        pending.rank_code,
      rankName:        pending.rank_name,
      cashIncentive,
      beginningBalance,
      endingBalance,
      processKey,
      achievementUid:  pending.achievement_uid,
      pendingCountAfter: pendingCount,
    };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureRankingTable,
  toMysqlDateTime,
  dateSortValue,
  getRankDefinitions,
  getLatestPairingSnapshot,
  getCurrentRank,
  getCurrentRankMap,
  getRankProgress,
  getAllRankings,
  getRankCashIncentive,
  processIncentive,
  refreshMemberRankSnapshot,
  refreshRankingForest,
  rebuildRankSnapshot,
  shouldRefreshRankState,
  buildSnapshotFromStoredRow,
  normalizeRankDefinitions,
  sumRepurchasePoints,
  getPackageRankingPolicy,
  filterRankDefinitionsForPackage,
  canReleaseRankAchievementForPackage,
  clampRankToPackage,
  RANKING_BASIS_LABEL,
  RANK_REQUIREMENTS,
  RANK_INCENTIVES,
  PACKAGE_LABELS,
};
