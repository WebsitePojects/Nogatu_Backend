/**
 * Unilevel Income Calculation
 * 1:1 port of PHP income-unilevel-fnc.php :: get_unilevel($parent, $level)
 *
 * Income Type 4 (income4)
 * - Recursive traversal of drefid relationships (unilevel, not binary)
 * - Level 1: 5% commission
 * - Levels 2-3: 3% commission
 * - Levels 4-5: 2% commission
 * - Levels 6-10: 1% commission
 * - Requires monthly maintenance (>= 200 points)
 */
const { pool } = require('../../config/database');
const { previousMonthRange } = require('../../utils/helpers');

/**
 * Get total repurchase points for a user in previous month
 * Mirrors PHP get_totalpoints()
 */
async function getTotalPoints(uid) {
  const { start, end } = previousMonthRange();

  const [rows] = await pool.query(
    `SELECT SUM(incentivepoints1) as ttlpoints
     FROM repurchasetab
     WHERE uid = ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
       AND producttype >= 100`,
    [uid, start, end]
  );

  return Number(rows[0]?.ttlpoints || 0);
}

/**
 * Check if user has met monthly maintenance requirement
 * Mirrors PHP chk_lastmaintenance()
 * Requires >= 200 points in repurchases last month
 */
async function checkLastMaintenance(uid) {
  const points = await getTotalPoints(uid);
  return points >= 200;
}

/**
 * Check if unilevel income has already been calculated this month
 * Mirrors PHP chk_unileveltransdate()
 */
async function checkUnilevelTransDate(uid) {
  const { start, end } = previousMonthRange();

  const [rows] = await pool.query(
    `SELECT * FROM incometransdatetab
     WHERE uid = ? AND incometype = 4
       AND DATE_FORMAT(lasttransdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(lasttransdate, '%Y-%m-%d') <= ?`,
    [uid, start, end]
  );

  return rows.length > 0 ? 1 : 0;
}

/**
 * Update income transaction date after calculation
 */
async function updateIncomeTransDate(uid, incomeType) {
  await pool.query(
    `INSERT INTO incometransdatetab (id, uid, incometype, lasttransdate)
     VALUES (NULL, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE lasttransdate = NOW()`,
    [uid, incomeType]
  );
}

/**
 * Recursively calculate unilevel income
 * @param {number} parent - Parent UID
 * @param {number} level - Current level (1-10)
 * @param {Object} totals - Accumulator { lev1: 0, lev23: 0, lev45: 0, lev610: 0 }
 */
async function calculateUnilevel(parent, level, totals) {
  if (level > 10) return;

  const [rows] = await pool.query(
    'SELECT uid FROM usertab WHERE drefid = ?',
    [parent]
  );

  for (const row of rows) {
    const points = await getTotalPoints(row.uid);

    if (points > 0) {
      if (level === 1) {
        totals.lev1 += points;
      } else if (level >= 2 && level <= 3) {
        totals.lev23 += points;
      } else if (level >= 4 && level <= 5) {
        totals.lev45 += points;
      } else if (level >= 6 && level <= 10) {
        totals.lev610 += points;
      }
    }

    await calculateUnilevel(row.uid, level + 1, totals);
  }
}

/**
 * Get unilevel income for a user
 * @param {number} uid - User ID
 * @returns {number} Total unilevel income
 */
async function getUnilevel(uid) {
  // Check maintenance requirement
  const hasMaintenance = await checkLastMaintenance(uid);
  if (!hasMaintenance) return 0;

  // Check if already calculated this month
  const alreadyCalculated = await checkUnilevelTransDate(uid);
  if (alreadyCalculated) return 0;

  const totals = { lev1: 0, lev23: 0, lev45: 0, lev610: 0 };
  await calculateUnilevel(uid, 1, totals);

  // Apply percentage rates
  const unilevel1 = totals.lev1 * 0.05;    // 5%
  const unilevel23 = totals.lev23 * 0.03;  // 3%
  const unilevel45 = totals.lev45 * 0.02;  // 2%
  const unilevel610 = totals.lev610 * 0.01; // 1%

  const total = unilevel1 + unilevel23 + unilevel45 + unilevel610;

  // Update transaction date
  if (total > 0) {
    await updateIncomeTransDate(uid, 4);
  }

  return total;
}

module.exports = { getUnilevel, checkLastMaintenance, checkUnilevelTransDate };
