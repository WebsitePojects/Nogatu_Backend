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

async function ensureRankingTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS rankingstab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      current_rank INT NOT NULL DEFAULT 0,
      rank_level INT NOT NULL DEFAULT 0,
      binary_points_total FLOAT NOT NULL DEFAULT 0,
      left_qualified_count INT NOT NULL DEFAULT 0,
      right_qualified_count INT NOT NULL DEFAULT 0,
      rank_date DATETIME DEFAULT NULL,
      qualified_date DATETIME DEFAULT NULL,
      incentive_status INT NOT NULL DEFAULT 0,
      reward_status INT NOT NULL DEFAULT 0,
      reward_claimed_date DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_uid (uid),
      KEY idx_current_rank (current_rank),
      KEY idx_rank_level (rank_level)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1`
  );
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

  const totalPoints = await getTotalPairingPoints(uid);
  const currentState = await getRankState(uid);
  const currentRank = currentState.rank;

  // Determine next rank target
  let nextRank = currentRank + 1;
  if (nextRank > 3) nextRank = 3;

  const nextReq = RANK_REQUIREMENTS[nextRank];
  const progress = nextReq ? Math.min(100, (totalPoints / nextReq.minPoints) * 100) : 100;

  // Check leg qualifications for next rank
  let legStatus = { leftQualified: false, rightQualified: false };
  if (nextRank === 1) {
    legStatus = await checkLegQualification(uid, 1);
  } else if (nextRank === 3) {
    legStatus = await checkLegQualification(uid, 2);
  }

  // Auto-promote if qualifications met
  let newRank = currentRank;
  for (let r = currentRank + 1; r <= 3; r++) {
    const req = RANK_REQUIREMENTS[r];
    if (totalPoints >= req.minPoints) {
      let qualified = true;
      if (r === 1) {
        const leg = await checkLegQualification(uid, 1);
        qualified = leg.leftQualified && leg.rightQualified;
      } else if (r === 3) {
        const leg = await checkLegQualification(uid, 2);
        qualified = leg.leftQualified && leg.rightQualified;
      }
      if (qualified) newRank = r;
      else break;
    } else {
      break;
    }
  }

  // Update rank if promoted
  if (newRank > currentRank) {
    await pool.query(
      `INSERT INTO rankingstab (
         uid, current_rank, rank_level, rank_date, qualified_date,
         incentive_status, reward_status, binary_points_total
       )
       VALUES (?, ?, ?, NOW(), NOW(), 0, 0, ?)
       ON DUPLICATE KEY UPDATE
         current_rank = VALUES(current_rank),
         rank_level = VALUES(rank_level),
         rank_date = NOW(),
         qualified_date = NOW(),
         binary_points_total = GREATEST(binary_points_total, VALUES(binary_points_total))`,
      [uid, newRank, newRank, totalPoints]
    );
  }

  const finalState = await getRankState(uid);

  return {
    uid,
    currentRank: newRank,
    currentRankLabel: RANK_REQUIREMENTS[newRank]?.label || 'None',
    currentRankColor: RANK_REQUIREMENTS[newRank]?.color || '#6B7280',
    totalPoints,
    nextRank: newRank < 3 ? newRank + 1 : null,
    nextRankLabel: newRank < 3 ? RANK_REQUIREMENTS[newRank + 1].label : 'Max Rank Achieved',
    nextRankMinPoints: newRank < 3 ? RANK_REQUIREMENTS[newRank + 1].minPoints : null,
    progress: Math.round(progress * 100) / 100,
    legStatus,
    incentives: RANK_INCENTIVES[newRank] || 'N/A',
    incentiveStatus: finalState.incentiveStatus,
  };
}

/**
 * Get all rankings for admin view
 */
async function getAllRankings(page = 1, perPage = 30) {
  await ensureRankingTable();

  const offset = (page - 1) * perPage;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) as total
     FROM rankingstab
     WHERE current_rank > 0 OR rank_level > 0`
  );
  const total = Number(countRows[0].total);

  const [rows] = await pool.query(
    `SELECT r.uid, r.current_rank, r.rank_level, r.rank_date, r.qualified_date,
            r.incentive_status, r.reward_status,
            m.firstname, m.lastname, m.username
     FROM rankingstab r
     LEFT JOIN memberstab m ON r.uid = m.uid
     WHERE r.current_rank > 0 OR r.rank_level > 0
     ORDER BY GREATEST(r.current_rank, r.rank_level) DESC, r.rank_date ASC
     LIMIT ?, ?`,
    [offset, perPage]
  );

  const rankings = rows.map((r) => {
    const rank = Math.max(Number(r.current_rank || 0), Number(r.rank_level || 0));
    return {
      ...r,
      current_rank: rank,
      rank_date: r.rank_date || r.qualified_date,
      incentive_status: Number(r.incentive_status || r.reward_status || 0),
      rankLabel: RANK_REQUIREMENTS[rank]?.label || 'Unknown',
      rankColor: RANK_REQUIREMENTS[rank]?.color || '#6B7280',
      incentives: RANK_INCENTIVES[rank] || 'N/A',
    };
  });

  return { rankings, total, page, totalPages: Math.ceil(total / perPage) };
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
  RANK_REQUIREMENTS,
  RANK_INCENTIVES,
};
