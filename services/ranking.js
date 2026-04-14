/**
 * Ranking Bonus System (DOC2 §4.2)
 *
 * Three supervisor ranks based on accumulated binary/pairing points:
 * - Supervisor 1: 10,000 pts + 1 qualified S1 in left + 1 S1 in right
 * - Supervisor 2: 20,000 pts (requirements TBD)
 * - Supervisor 3: 40,000 pts + 1 qualified S2 in left + 1 S2 in right
 */
const { pool } = require('../config/database');

const RANK_REQUIREMENTS = {
  1: { minPoints: 10000, label: 'Supervisor 1', color: '#CD7F32' },
  2: { minPoints: 20000, label: 'Supervisor 2', color: '#C0C0C0' },
  3: { minPoints: 40000, label: 'Supervisor 3', color: '#FFD700' },
};

const RANK_INCENTIVES = {
  1: 'DP Motorcycle, ₱5,000, White T-shirt',
  2: 'Laptop, ₱10,000, White Polo',
  3: 'International Asian Travel, ₱20,000, Silver Pin',
};

const PACKAGE_LABELS = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

const RANK_REFRESH_MAX_AGE_MINUTES = 15;

async function ensureIndex(tableName, indexName, alterSql) {
  const [rows] = await pool.query(`SHOW INDEX FROM ${tableName} WHERE Key_name = ?`, [indexName]);
  if (rows.length === 0) {
    await pool.query(alterSql);
  }
}

async function ensureRankingTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS rankingstab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      current_rank INT NOT NULL DEFAULT 0,
      rank_level INT NOT NULL DEFAULT 0,
      binary_points_total FLOAT NOT NULL DEFAULT 0,
      basis_points FLOAT NOT NULL DEFAULT 0,
      basis_label VARCHAR(120) DEFAULT NULL,
      left_qualified_count INT NOT NULL DEFAULT 0,
      right_qualified_count INT NOT NULL DEFAULT 0,
      rank_date DATETIME DEFAULT NULL,
      qualified_date DATETIME DEFAULT NULL,
      incentive_status INT NOT NULL DEFAULT 0,
      reward_status INT NOT NULL DEFAULT 0,
      reward_claimed_date DATETIME DEFAULT NULL,
      last_calculated_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_uid (uid),
      KEY idx_current_rank (current_rank),
      KEY idx_rank_level (rank_level)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1`
  );

  const [cols] = await pool.query('SHOW COLUMNS FROM rankingstab');
  const columnSet = new Set(cols.map((col) => String(col.Field || '').toLowerCase()));

  if (!columnSet.has('basis_points')) {
    await pool.query('ALTER TABLE rankingstab ADD COLUMN basis_points FLOAT NOT NULL DEFAULT 0 AFTER binary_points_total');
  }
  if (!columnSet.has('basis_label')) {
    await pool.query('ALTER TABLE rankingstab ADD COLUMN basis_label VARCHAR(120) DEFAULT NULL AFTER basis_points');
  }
  if (!columnSet.has('last_calculated_at')) {
    await pool.query('ALTER TABLE rankingstab ADD COLUMN last_calculated_at DATETIME DEFAULT NULL AFTER reward_claimed_date');
  }

  await ensureIndex('rankingstab', 'idx_basis_points', 'ALTER TABLE rankingstab ADD INDEX idx_basis_points (basis_points)');
  await ensureIndex('rankingstab', 'idx_last_calculated_at', 'ALTER TABLE rankingstab ADD INDEX idx_last_calculated_at (last_calculated_at)');
  await ensureIndex('pairingstab', 'idx_uid_transdate_id', 'ALTER TABLE pairingstab ADD INDEX idx_uid_transdate_id (uid, transdate, id)');
  await ensureIndex('pairingstab', 'idx_uid_totalbpay', 'ALTER TABLE pairingstab ADD INDEX idx_uid_totalbpay (uid, totalbpay)');
  await ensureIndex('usertab', 'idx_refid_position_uid', 'ALTER TABLE usertab ADD INDEX idx_refid_position_uid (refid, position, uid)');
  await ensureIndex('usertab', 'idx_codeid_uid_mainid', 'ALTER TABLE usertab ADD INDEX idx_codeid_uid_mainid (codeid, uid, mainid)');
}

function toNumber(value) {
  return Number(value || 0);
}

function shouldRefreshRankState(row) {
  if (!row) return true;

  const dbBasisPoints = toNumber(row.db_basis_points);
  const liveBasisPoints = toNumber(row.live_basis_points);
  if (Math.abs(dbBasisPoints - liveBasisPoints) > 0.001) return true;

  if (!row.last_calculated_at) return true;

  const lastCalculatedAt = new Date(row.last_calculated_at);
  if (Number.isNaN(lastCalculatedAt.getTime())) return true;

  const ageMs = Date.now() - lastCalculatedAt.getTime();
  if (ageMs > RANK_REFRESH_MAX_AGE_MINUTES * 60 * 1000) return true;

  if (toNumber(row.current_rank) > 0 && !(row.rank_date || row.qualified_date)) return true;

  return false;
}

function parseRankRow(row) {
  if (!row) {
    return {
      rank: 0,
      incentiveStatus: 0,
      rewardStatus: 0,
      rankDate: null,
    };
  }

  return {
    rank: Math.max(Number(row.current_rank || 0), Number(row.rank_level || 0)),
    incentiveStatus: Number(row.incentive_status || 0),
    rewardStatus: Number(row.reward_status || 0),
    rankDate: row.rank_date || row.qualified_date || null,
  };
}

/**
 * Get total accumulated pairing points for a user
 */
async function getTotalPairingPoints(uid) {
  const [rows] = await pool.query(
    'SELECT SUM(totalpoints) as ttlpoints FROM pairingstab WHERE uid = ?',
    [uid]
  );
  return Number(rows[0]?.ttlpoints || 0);
}

async function getRankingBasis(uid) {
  const [rows] = await pool.query(
    `SELECT COALESCE(MAX(totalpointsleft), 0) AS max_left_points,
            COALESCE(MAX(totalpointsright), 0) AS max_right_points
       FROM pairingstab
      WHERE uid = ?`,
    [uid]
  );

  const row = rows[0] || {};
  const leftPoints = toNumber(row.max_left_points);
  const rightPoints = toNumber(row.max_right_points);
  const basisPoints = leftPoints + rightPoints;

  return {
    basisPoints,
    basisLabel: 'Combined binary leg points',
  };
}

async function getLatestPairingSnapshot(uid) {
  const [rows] = await pool.query(
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
    leftCount: toNumber(row.totalleft),
    rightCount: toNumber(row.totalright),
    leftPoints: toNumber(row.totalpointsleft),
    rightPoints: toNumber(row.totalpointsright),
  };
}

/**
 * Check binary leg qualifications for rank requirements
 * S1 requires: 1 S1 in left leg + 1 S1 in right leg
 * S3 requires: 1 S2 in left leg + 1 S2 in right leg
 */
async function checkLegQualification(uid, requiredRank) {
  // Get direct binary children
  const [children] = await pool.query(
    'SELECT uid, position FROM usertab WHERE refid = ?',
    [uid]
  );

  let leftQualified = false;
  let rightQualified = false;

  for (const child of children) {
    const childRank = await getCurrentRank(child.uid);
    if (childRank >= requiredRank) {
      if (Number(child.position) === 1) leftQualified = true;
      if (Number(child.position) === 2) rightQualified = true;
    }

    // Also check deeper in the same leg
    if (!leftQualified && Number(child.position) === 1) {
      leftQualified = await hasQualifiedDownline(child.uid, requiredRank);
    }
    if (!rightQualified && Number(child.position) === 2) {
      rightQualified = await hasQualifiedDownline(child.uid, requiredRank);
    }
  }

  return { leftQualified, rightQualified };
}

/**
 * Recursively check if any downline member has the required rank
 */
async function hasQualifiedDownline(parentUid, requiredRank) {
  const [children] = await pool.query(
    'SELECT uid FROM usertab WHERE refid = ?',
    [parentUid]
  );

  for (const child of children) {
    const rank = await getCurrentRank(child.uid);
    if (rank >= requiredRank) return true;
    const found = await hasQualifiedDownline(child.uid, requiredRank);
    if (found) return true;
  }

  return false;
}

/**
 * Get current rank from rankingstab
 */
async function getCurrentRank(uid) {
  const [rows] = await pool.query(
    `SELECT current_rank, rank_level, incentive_status, reward_status,
            rank_date, qualified_date
     FROM rankingstab WHERE uid = ?`,
    [uid]
  );

  return parseRankRow(rows[0]).rank;
}

async function getCurrentRankMap(uidList) {
  if (!uidList || uidList.length === 0) return new Map();

  const uniqueIds = [...new Set(uidList.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (uniqueIds.length === 0) return new Map();

  const placeholders = uniqueIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT uid, current_rank, rank_level
     FROM rankingstab
     WHERE uid IN (${placeholders})`,
    uniqueIds
  );

  const rankMap = new Map();
  for (const row of rows) {
    rankMap.set(Number(row.uid), Math.max(toNumber(row.current_rank), toNumber(row.rank_level)));
  }
  return rankMap;
}

async function collectLegDownlineUids(uid) {
  const [directRows] = await pool.query(
    'SELECT uid, position FROM usertab WHERE refid = ?',
    [uid]
  );

  const queue = [];
  const visited = new Set();

  for (const row of directRows) {
    const childUid = Number(row.uid);
    if (!childUid || visited.has(childUid)) continue;
    const side = Number(row.position) === 1 ? 'left' : 'right';
    queue.push({ uid: childUid, side });
    visited.add(childUid);
  }

  const leftUids = [];
  const rightUids = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.side === 'left') leftUids.push(current.uid);
    else rightUids.push(current.uid);

    const [children] = await pool.query('SELECT uid FROM usertab WHERE refid = ?', [current.uid]);
    for (const child of children) {
      const childUid = Number(child.uid);
      if (!childUid || visited.has(childUid)) continue;
      queue.push({ uid: childUid, side: current.side });
      visited.add(childUid);
    }
  }

  return { leftUids, rightUids };
}

async function getLegQualification(uid, requiredRank) {
  const { leftUids, rightUids } = await collectLegDownlineUids(uid);
  const rankMap = await getCurrentRankMap([...leftUids, ...rightUids]);

  let leftQualifiedCount = 0;
  let rightQualifiedCount = 0;

  for (const leftUid of leftUids) {
    if (toNumber(rankMap.get(leftUid)) >= requiredRank) leftQualifiedCount += 1;
  }
  for (const rightUid of rightUids) {
    if (toNumber(rankMap.get(rightUid)) >= requiredRank) rightQualifiedCount += 1;
  }

  return {
    leftQualified: leftQualifiedCount > 0,
    rightQualified: rightQualifiedCount > 0,
    leftQualifiedCount,
    rightQualifiedCount,
  };
}

async function upsertRankState(uid, payload) {
  await pool.query(
    `INSERT INTO rankingstab (
       uid, current_rank, rank_level, binary_points_total,
       basis_points, basis_label,
       left_qualified_count, right_qualified_count,
       rank_date, qualified_date, incentive_status, reward_status
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? > 0 THEN NOW() ELSE NULL END,
             CASE WHEN ? > 0 THEN NOW() ELSE NULL END,
             0, 0)
     ON DUPLICATE KEY UPDATE
       current_rank = VALUES(current_rank),
       rank_level = VALUES(rank_level),
       binary_points_total = VALUES(binary_points_total),
       basis_points = VALUES(basis_points),
       basis_label = VALUES(basis_label),
       left_qualified_count = VALUES(left_qualified_count),
       right_qualified_count = VALUES(right_qualified_count),
       rank_date = IF(VALUES(current_rank) > current_rank, NOW(), rank_date),
       qualified_date = CASE
         WHEN VALUES(current_rank) <= 0 AND current_rank <= 0 THEN NULL
         WHEN VALUES(current_rank) > current_rank THEN NOW()
         ELSE qualified_date
       END,
       last_calculated_at = NOW()`,
    [
      uid,
      payload.currentRank,
      payload.currentRank,
      payload.binaryPoints,
      payload.basisPoints,
      payload.basisLabel,
      payload.leftQualifiedCount,
      payload.rightQualifiedCount,
      payload.currentRank,
      payload.currentRank,
    ]
  );
}

async function getRankState(uid) {
  await ensureRankingTable();

  const [rows] = await pool.query(
    `SELECT current_rank, rank_level, incentive_status, reward_status,
            rank_date, qualified_date
     FROM rankingstab WHERE uid = ?`,
    [uid]
  );

  return parseRankRow(rows[0]);
}

/**
 * Calculate rank progress for a member
 */
async function getRankProgress(uid) {
  await ensureRankingTable();

  const pairing = await getLatestPairingSnapshot(uid);
  const basis = await getRankingBasis(uid);
  const totalPoints = basis.basisPoints;
  const currentState = await getRankState(uid);
  const currentRank = currentState.rank;

  const legForS1 = await getLegQualification(uid, 1);
  const legForS2 = await getLegQualification(uid, 2);

  const isS1Qualified = totalPoints >= RANK_REQUIREMENTS[1].minPoints && legForS1.leftQualified && legForS1.rightQualified;
  const isS2Qualified = totalPoints >= RANK_REQUIREMENTS[2].minPoints;
  const isS3Qualified = totalPoints >= RANK_REQUIREMENTS[3].minPoints && legForS2.leftQualified && legForS2.rightQualified;

  let newRank = 0;
  if (isS1Qualified) newRank = 1;
  if (isS1Qualified && isS2Qualified) newRank = 2;
  if (isS1Qualified && isS2Qualified && isS3Qualified) newRank = 3;

  const effectiveRank = Math.max(currentRank, newRank);
  await upsertRankState(uid, {
    currentRank: effectiveRank,
    binaryPoints: totalPoints,
    basisPoints: basis.basisPoints,
    basisLabel: basis.basisLabel,
    leftQualifiedCount: legForS1.leftQualifiedCount,
    rightQualifiedCount: legForS1.rightQualifiedCount,
  });

  const finalState = await getRankState(uid);

  // Determine next rank target
  let nextRank = effectiveRank + 1;
  if (nextRank > 3) nextRank = 3;

  const nextReq = RANK_REQUIREMENTS[nextRank];
  const progress = nextReq ? Math.min(100, (totalPoints / nextReq.minPoints) * 100) : 100;

  // Next-rank leg check (only rank1 and rank3 have structure requirements).
  let legStatus = { leftQualified: false, rightQualified: false };
  if (nextRank === 1) {
    legStatus = { leftQualified: legForS1.leftQualified, rightQualified: legForS1.rightQualified };
  } else if (nextRank === 3) {
    legStatus = { leftQualified: legForS2.leftQualified, rightQualified: legForS2.rightQualified };
  }

  const ranks = [1, 2, 3].map((rankNo) => ({
    rank: rankNo,
    label: RANK_REQUIREMENTS[rankNo].label,
    minPoints: RANK_REQUIREMENTS[rankNo].minPoints,
    qualified:
      rankNo === 1 ? isS1Qualified :
      rankNo === 2 ? (isS1Qualified && isS2Qualified) :
      (isS1Qualified && isS2Qualified && isS3Qualified),
    qualifiedDate: finalState.rankDate,
  }));

  return {
    uid,
    currentRank: effectiveRank,
    currentRankLabel: RANK_REQUIREMENTS[effectiveRank]?.label || 'Unranked',
    currentRankColor: RANK_REQUIREMENTS[effectiveRank]?.color || '#6B7280',
    binaryPoints: totalPoints,
    basisPoints: basis.basisPoints,
    basisLabel: basis.basisLabel,
    qualifiedDate: finalState.rankDate,
    totalPoints,
    left: {
      count: pairing.leftCount,
      points: pairing.leftPoints,
      qualifiedS1: legForS1.leftQualified ? 1 : 0,
      qualifiedS2: legForS2.leftQualified ? 1 : 0,
    },
    right: {
      count: pairing.rightCount,
      points: pairing.rightPoints,
      qualifiedS1: legForS1.rightQualified ? 1 : 0,
      qualifiedS2: legForS2.rightQualified ? 1 : 0,
    },
    ranks,
    nextRank: effectiveRank < 3 ? effectiveRank + 1 : null,
    nextRankLabel: effectiveRank < 3 ? RANK_REQUIREMENTS[effectiveRank + 1].label : 'Max Rank Achieved',
    nextRankMinPoints: effectiveRank < 3 ? RANK_REQUIREMENTS[effectiveRank + 1].minPoints : null,
    progress: Math.round(progress * 100) / 100,
    legStatus,
    incentives: RANK_INCENTIVES[effectiveRank] || 'N/A',
    incentiveStatus: finalState.incentiveStatus,
    rewardStatus: finalState.rewardStatus,
  };
}

/**
 * Get all rankings for admin view
 */
async function getAllRankings(page = 1, perPage = 30) {
  await ensureRankingTable();

  const currentPage = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(perPage) || 30));
  const offset = (currentPage - 1) * size;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) as total
     FROM usertab u
     WHERE u.codeid = 1 AND u.uid = u.mainid`
  );
  const total = Number(countRows[0]?.total || 0);

  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype,
            m.firstname, m.lastname, m.username,
            COALESCE(r.current_rank, 0) AS current_rank,
            COALESCE(r.rank_level, 0) AS rank_level,
            COALESCE(r.basis_points, 0) AS db_basis_points,
            r.basis_label,
            r.rank_date, r.qualified_date,
            COALESCE(r.incentive_status, 0) AS incentive_status,
            COALESCE(r.reward_status, 0) AS reward_status,
            r.last_calculated_at,
            COALESCE(stats.max_left_points, 0) AS max_left_points,
            COALESCE(stats.max_right_points, 0) AS max_right_points,
            (COALESCE(stats.max_left_points, 0) + COALESCE(stats.max_right_points, 0)) AS live_basis_points
     FROM usertab u
     INNER JOIN memberstab m ON m.uid = u.uid
     LEFT JOIN rankingstab r ON r.uid = u.uid
     LEFT JOIN (
       SELECT uid,
              COALESCE(MAX(totalpointsleft), 0) AS max_left_points,
              COALESCE(MAX(totalpointsright), 0) AS max_right_points
         FROM pairingstab
        GROUP BY uid
     ) stats ON stats.uid = u.uid
     WHERE u.codeid = 1 AND u.uid = u.mainid
     ORDER BY live_basis_points DESC, u.uid ASC
     LIMIT ?, ?`,
    [offset, size]
  );

  const hydratedRows = await Promise.all(rows.map(async (r, idx) => {
    const needsRefresh = shouldRefreshRankState(r);
    const progress = needsRefresh ? await getRankProgress(r.uid) : null;
    const storedRank = Math.max(toNumber(r.current_rank), toNumber(r.rank_level));
    const basisPoints = progress ? toNumber(progress.basisPoints) : toNumber(r.live_basis_points);
    const effectiveRank = progress ? toNumber(progress.currentRank) : storedRank;
    const qualifiedDate = effectiveRank > 0
      ? (progress?.qualifiedDate || r.qualified_date || r.rank_date || null)
      : null;

    return {
      uid: toNumber(r.uid),
      firstname: r.firstname,
      lastname: r.lastname,
      username: r.username,
      packageType: toNumber(r.currentaccttype),
      packageLabel: PACKAGE_LABELS[toNumber(r.currentaccttype)] || 'Unknown',
      basisPoints,
      basisLabel: progress?.basisLabel || r.basis_label || 'Combined binary leg points',
      binaryPoints: basisPoints,
      current_rank: effectiveRank,
      supervisorLevel: effectiveRank,
      rankLabel: RANK_REQUIREMENTS[effectiveRank]?.label || 'Unranked',
      rankColor: RANK_REQUIREMENTS[effectiveRank]?.color || '#6B7280',
      incentives: RANK_INCENTIVES[effectiveRank] || 'N/A',
      rank_date: qualifiedDate,
      qualifiedDate,
      incentive_status: progress ? toNumber(progress.incentiveStatus) : toNumber(r.incentive_status),
      reward_status: progress ? toNumber(progress.rewardStatus) : toNumber(r.reward_status),
      rewardStatus: progress ? toNumber(progress.rewardStatus) : toNumber(r.reward_status),
      position: offset + idx + 1,
    };
  }));

  return {
    rankings: hydratedRows,
    total,
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(total / size)),
    perPage: size,
  };
}

/**
 * Process incentive claim (admin)
 */
async function processIncentive(uid) {
  await ensureRankingTable();

  const [result] = await pool.query(
    `UPDATE rankingstab
        SET incentive_status = 1,
            reward_status = 1,
            reward_claimed_date = NOW()
      WHERE uid = ? AND (incentive_status = 0 OR reward_status = 0)`,
    [uid]
  );
  return result.affectedRows > 0;
}

module.exports = {
  ensureRankingTable,
  getRankProgress,
  getAllRankings,
  processIncentive,
  getCurrentRank,
  getLatestPairingSnapshot,
  RANK_REQUIREMENTS,
  RANK_INCENTIVES,
  PACKAGE_LABELS,
};
