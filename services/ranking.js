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
    'SELECT current_rank FROM rankingstab WHERE uid = ?',
    [uid]
  );
  return rows.length > 0 ? Number(rows[0].current_rank) : 0;
}

/**
 * Calculate rank progress for a member
 */
async function getRankProgress(uid) {
  const totalPoints = await getTotalPairingPoints(uid);
  const currentRank = await getCurrentRank(uid);

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
      `INSERT INTO rankingstab (uid, current_rank, rank_date, incentive_status)
       VALUES (?, ?, NOW(), 0)
       ON DUPLICATE KEY UPDATE current_rank = ?, rank_date = NOW()`,
      [uid, newRank, newRank]
    );
  }

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
    incentiveStatus: 0, // Will be read from DB
  };
}

/**
 * Get all rankings for admin view
 */
async function getAllRankings(page = 1, perPage = 30) {
  const offset = (page - 1) * perPage;

  const [countRows] = await pool.query(
    'SELECT COUNT(*) as total FROM rankingstab WHERE current_rank > 0'
  );
  const total = Number(countRows[0].total);

  const [rows] = await pool.query(
    `SELECT r.uid, r.current_rank, r.rank_date, r.incentive_status,
            m.firstname, m.lastname, m.username
     FROM rankingstab r
     LEFT JOIN memberstab m ON r.uid = m.uid
     WHERE r.current_rank > 0
     ORDER BY r.current_rank DESC, r.rank_date ASC
     LIMIT ?, ?`,
    [offset, perPage]
  );

  const rankings = rows.map(r => ({
    ...r,
    rankLabel: RANK_REQUIREMENTS[r.current_rank]?.label || 'Unknown',
    rankColor: RANK_REQUIREMENTS[r.current_rank]?.color || '#6B7280',
    incentives: RANK_INCENTIVES[r.current_rank] || 'N/A',
  }));

  return { rankings, total, page, totalPages: Math.ceil(total / perPage) };
}

/**
 * Process incentive claim (admin)
 */
async function processIncentive(uid) {
  const [result] = await pool.query(
    'UPDATE rankingstab SET incentive_status = 1 WHERE uid = ? AND incentive_status = 0',
    [uid]
  );
  return result.affectedRows > 0;
}

module.exports = {
  getRankProgress,
  getAllRankings,
  processIncentive,
  getCurrentRank,
  RANK_REQUIREMENTS,
  RANK_INCENTIVES,
};
