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
const { previousMonthRange, currentMonthRange, PRODUCT_TYPES } = require('../../utils/helpers');
const { getPackagePolicy } = require('../packagePolicy');

/**
 * Get total repurchase points for a user in previous month
 * Mirrors PHP get_totalpoints()
 */
async function getTotalPointsForRange(uid, start, end) {
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

async function getTotalPoints(uid) {
  const { start, end } = previousMonthRange();
  return getTotalPointsForRange(uid, start, end);
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
 * Mirrors PHP chk_unileveltransdate() — uses CURRENT month range
 * to prevent duplicate calculation within the same calendar month
 */
async function checkUnilevelTransDate(uid) {
  const { start, end } = currentMonthRange();

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
 * Recursively calculate unilevel income.
 *
 * This intentionally mirrors production PHP `ctl_level` behavior:
 * qualifying points are added to all level buckets when the ctl gate passes.
 * Even though this is counterintuitive, it must match production output.
 *
 * @param {number} parent - Parent UID
 * @param {number} level - Current level (1-10)
 * @param {{ ctlLevel: number, totals: { lev1: number, lev23: number, lev45: number, lev610: number } }} state
 */
async function calculateUnilevel(parent, level, state, getPointsForUid) {
  if (level > 10 || level > Number(state.maxReach || 10)) return;

  const [rows] = await pool.query(
    'SELECT uid FROM usertab WHERE drefid = ?',
    [parent]
  );

  for (const row of rows) {
    if (level >= 1 && level <= 10) {
      const uidPurchases = await getPointsForUid(row.uid);

      if (uidPurchases > 0 && state.ctlLevel <= 10 && state.ctlLevel <= level) {
        state.ctlLevel += 1;

        state.totals.lev1 += uidPurchases;
        state.totals.lev23 += uidPurchases;
        state.totals.lev45 += uidPurchases;
        state.totals.lev610 += uidPurchases;

        if (state.ctlLevel >= level) {
          state.ctlLevel = level;
        }
      }
    }

    await calculateUnilevel(row.uid, level + 1, state, getPointsForUid);
  }
}

async function calculateUnilevelForWindow(uid, options = {}) {
  const {
    start,
    end,
    requireMaintenance = true,
    preventDuplicateCredit = true,
  } = options;

  if (!start || !end) return 0;

  if (requireMaintenance) {
    const selfPoints = await getTotalPointsForRange(uid, start, end);
    if (selfPoints < 200) return 0;
  }

  if (preventDuplicateCredit) {
    const alreadyCalculated = await checkUnilevelTransDate(uid);
    if (alreadyCalculated) return 0;
  }

  const [packageRows] = await pool.query(
    'SELECT currentaccttype FROM usertab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const packagePolicy = getPackagePolicy(packageRows[0]?.currentaccttype || 0);

  const state = {
    ctlLevel: 0,
    maxReach: Number(packagePolicy.unilevelReach || 0) || 0,
    totals: { lev1: 0, lev23: 0, lev45: 0, lev610: 0 },
  };

  if (state.maxReach <= 0) {
    return 0;
  }

  await calculateUnilevel(uid, 1, state, (memberUid) => getTotalPointsForRange(memberUid, start, end));

  const unilevel1 = state.totals.lev1 * 0.05;
  const unilevel23 = state.totals.lev23 * 0.03;
  const unilevel45 = state.totals.lev45 * 0.02;
  const unilevel610 = state.totals.lev610 * 0.01;

  const total = unilevel1 + unilevel23 + unilevel45 + unilevel610;

  if (preventDuplicateCredit && total > 0) {
    await updateIncomeTransDate(uid, 4);
  }

  return total;
}

/**
 * Get unilevel income for a user
 * @param {number} uid - User ID
 * @returns {number} Total unilevel income
 */
async function getUnilevel(uid) {
  const { start, end } = previousMonthRange();
  return calculateUnilevelForWindow(uid, {
    start,
    end,
    requireMaintenance: true,
    preventDuplicateCredit: true,
  });
}

async function getProjectedCurrentMonthUnilevel(uid) {
  const { start, end } = currentMonthRange();
  return calculateUnilevelForWindow(uid, {
    start,
    end,
    requireMaintenance: false,
    preventDuplicateCredit: false,
  });
}

function getUnilevelRateForLevel(level) {
  const numericLevel = Number(level || 0);
  if (numericLevel === 1) return 0.05;
  if (numericLevel >= 2 && numericLevel <= 3) return 0.03;
  if (numericLevel >= 4 && numericLevel <= 5) return 0.02;
  if (numericLevel >= 6 && numericLevel <= 10) return 0.01;
  return 0;
}

function buildInClause(values = []) {
  return values.map(() => '?').join(', ');
}

async function getUnilevelProductPointContributors(uid, options = {}) {
  const { start, end } = options.start && options.end ? options : currentMonthRange();
  const [packageRows] = await pool.query(
    'SELECT currentaccttype FROM usertab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const policy = getPackagePolicy(packageRows[0]?.currentaccttype || 0);
  const maxReach = Math.max(0, Math.min(10, Number(options.maxReach || policy.unilevelReach || 0)));

  if (!maxReach) {
    return {
      rows: [],
      totalPoints: 0,
      projectedAmount: 0,
      maxReach,
    };
  }

  let parents = [Number(uid)];
  const rows = [];

  for (let level = 1; level <= maxReach && parents.length > 0; level += 1) {
    const parentPlaceholders = buildInClause(parents);
    const [children] = await pool.query(
      `SELECT u.uid, u.drefid, u.currentaccttype,
              m.username, m.firstname, m.lastname
         FROM usertab u
         LEFT JOIN memberstab m ON m.uid = u.uid
        WHERE u.drefid IN (${parentPlaceholders})
        ORDER BY u.id ASC`,
      parents
    );

    const childUids = children.map((child) => Number(child.uid || 0)).filter(Boolean);
    if (childUids.length === 0) {
      parents = [];
      continue;
    }

    const childByUid = new Map(children.map((child) => [Number(child.uid), child]));
    const childPlaceholders = buildInClause(childUids);
    const [pointRows] = await pool.query(
      `SELECT uid, producttype,
              COALESCE(SUM(incentivepoints1), 0) AS product_points,
              COUNT(*) AS purchase_count,
              MAX(transdate) AS last_transdate
         FROM repurchasetab
        WHERE uid IN (${childPlaceholders})
          AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
          AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
          AND producttype >= 100
        GROUP BY uid, producttype
        HAVING product_points > 0
        ORDER BY last_transdate DESC`,
      [...childUids, start, end]
    );

    const rate = getUnilevelRateForLevel(level);
    for (const pointRow of pointRows) {
      const source = childByUid.get(Number(pointRow.uid)) || {};
      const points = Number(pointRow.product_points || 0);
      rows.push({
        uid: Number(pointRow.uid || 0),
        username: source.username || null,
        fullname: `${source.firstname || ''} ${source.lastname || ''}`.trim() || source.username || 'Not available',
        level,
        producttype: Number(pointRow.producttype || 0),
        productName: PRODUCT_TYPES[Number(pointRow.producttype || 0)] || `Product ${pointRow.producttype}`,
        productPoints: points,
        purchaseCount: Number(pointRow.purchase_count || 0),
        ratePercent: rate * 100,
        amount: points * rate,
        projectedAmount: points * rate,
        transdate: pointRow.last_transdate,
        rowType: 'downline_product_points',
      });
    }

    parents = childUids;
  }

  const totalPoints = rows.reduce((sum, row) => sum + Number(row.productPoints || 0), 0);
  const projectedAmount = rows.reduce((sum, row) => sum + Number(row.projectedAmount || row.amount || 0), 0);

  return {
    rows,
    totalPoints,
    projectedAmount,
    maxReach,
  };
}

module.exports = {
  getUnilevel,
  checkLastMaintenance,
  checkUnilevelTransDate,
  getProjectedCurrentMonthUnilevel,
  getUnilevelProductPointContributors,
  getUnilevelRateForLevel,
  getTotalPointsForRange,
};
