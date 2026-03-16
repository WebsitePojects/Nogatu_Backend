/**
 * Leadership Bonus Calculation
 * 1:1 port of PHP income-leadership-2026-fnc.php (latest version)
 *
 * Income Type 3 (income3)
 * - Recursive tree traversal via drefid relationships
 * - Level-based percentage rates:
 *   Level 1 (direct): 5% of income
 *   Level 2: 2% of income
 *   Levels 3-5: 1% of income
 */
const { pool } = require('../../config/database');

/**
 * Recursively get direct referral tree for leadership calculation
 * @param {number} parent - Parent UID
 * @param {number} level - Current level (1-based)
 * @param {Array} results - Accumulator array
 */
async function getLeadershipDref(parent, level, results) {
  if (level > 5) return; // Cap at 5 levels

  const [rows] = await pool.query(
    'SELECT uid, drefid FROM usertab WHERE drefid = ?',
    [parent]
  );

  for (const row of rows) {
    // Get this user's total pairing income (ttlincome2 from payouttotaltab)
    const [incomeRows] = await pool.query(
      'SELECT ttlincome2 FROM payouttotaltab WHERE uid = ?',
      [row.uid]
    );

    const income = Number(incomeRows[0]?.ttlincome2 || 0);

    results.push({
      uid: row.uid,
      level: level,
      income: income,
    });

    // Recurse to next level
    await getLeadershipDref(row.uid, level + 1, results);
  }
}

/**
 * Calculate leadership bonus for a user
 * @param {number} uid - User ID
 * @returns {number} Total leadership bonus
 */
async function getLeadershipBonus(uid) {
  const results = [];
  await getLeadershipDref(uid, 1, results);

  let level1Total = 0;
  let level2Total = 0;
  let level35Total = 0;

  for (const r of results) {
    if (r.level === 1) {
      level1Total += r.income;
    } else if (r.level === 2) {
      level2Total += r.income;
    } else if (r.level >= 3 && r.level <= 5) {
      level35Total += r.income;
    }
  }

  // Apply percentage rates
  const leadershipTotal1 = level1Total * 0.05;  // 5%
  const leadershipTotal2 = level2Total * 0.02;  // 2%
  const leadershipTotal35 = level35Total * 0.01; // 1%

  return leadershipTotal1 + leadershipTotal2 + leadershipTotal35;
}

module.exports = { getLeadershipBonus };
