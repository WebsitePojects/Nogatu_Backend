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

// Unilevel is RELEASED on/after the 5th of the month (Asia/Manila), crediting the PREVIOUS
// month's commission ("released every 5th of the following month"). Before the 5th, settlement
// returns 0 so nothing is credited early — keeps the released-on-the-5th rule accurate whether
// it fires on member wallet load or via the monthly cron (scripts/settle_unilevel_month.js).
const UNILEVEL_RELEASE_DAY = 5;

function isUnilevelReleaseWindow(now = new Date()) {
  // Manila is a fixed UTC+8 offset (no DST). Read the day-of-month in Manila wall-clock.
  const manilaDay = new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCDate();
  return manilaDay >= UNILEVEL_RELEASE_DAY;
}

/**
 * Get total repurchase points for a user in previous month
 * Mirrors PHP get_totalpoints()
 */
async function getTotalPointsForRange(uid, start, end, bucket = null) {
  // bucket: 'unilevel' (maintenance/income) | 'hifive' | null (all buckets — legacy).
  // Legacy rows default to maintenance_bucket='unilevel' (V036), so filtering by
  // 'unilevel' preserves historical unilevel behavior exactly.
  const run = async (useBucket) => {
    const bucketSql = useBucket ? 'AND maintenance_bucket = ?' : '';
    const params = useBucket ? [uid, start, end, bucket] : [uid, start, end];
    const [rows] = await pool.query(
      `SELECT SUM(incentivepoints1) as ttlpoints
       FROM repurchasetab
       WHERE uid = ?
         AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
         AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
         AND producttype >= 100
         ${bucketSql}`,
      params
    );
    return Number(rows[0]?.ttlpoints || 0);
  };

  if (!bucket) return run(false);
  // Deploy-order safety: if maintenance_bucket isn't present yet (pre-V036), fall back
  // to all-bucket so unilevel income can never break on a column-missing environment.
  try {
    return await run(true);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return run(false);
    throw err;
  }
}

async function getTotalPoints(uid) {
  const { start, end } = previousMonthRange();
  return getTotalPointsForRange(uid, start, end, 'unilevel');
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
async function updateIncomeTransDate(uid, incomeType, conn = pool) {
  await conn.query(
    `INSERT INTO incometransdatetab (id, uid, incometype, lasttransdate)
     VALUES (NULL, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE lasttransdate = NOW()`,
    [uid, incomeType]
  );
}

/**
 * H2 backstop — monotonic per-month guard independent of the incometransdatetab stamp.
 * True if a unilevel (income4) credit row already exists for this member in the CURRENT
 * calendar month. Even if the stamp row is deleted/reset, this prevents a second monthly
 * credit (double-pay). Scoped to the current month because unilevel is released this month
 * for the previous month's maintenance.
 */
async function hasUnilevelCreditedThisMonth(uid, conn = pool) {
  const { start, end } = currentMonthRange();
  const [rows] = await conn.query(
    `SELECT 1 FROM payouthistorytab
      WHERE uid = ? AND income4 > 0
        AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
        AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
      LIMIT 1`,
    [uid, start, end]
  );
  return rows.length > 0;
}

function addUnilevelPointsToLevelBucket(totals, level, points) {
  const numericPoints = Number(points || 0);
  if (numericPoints <= 0) return;

  if (level === 1) {
    totals.lev1 += numericPoints;
    return;
  }
  if (level >= 2 && level <= 3) {
    totals.lev23 += numericPoints;
    return;
  }
  if (level >= 4 && level <= 5) {
    totals.lev45 += numericPoints;
    return;
  }
  if (level >= 6 && level <= 10) {
    totals.lev610 += numericPoints;
  }
}

// Unilevel rate schedule by EFFECTIVE level (after rollup compression).
const UNILEVEL_RATES = [0.05, 0.03, 0.03, 0.02, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01];
// Scan deeper than the package reach so qualifying levels at depth 11/12/13… can
// still compress up into effective levels 1/2/3…
const MAX_UNILEVEL_SCAN_DEPTH = 30;

/**
 * ROLLUP COMPRESSION (approved comp-plan rule, 2026-06-17):
 * Empty levels (no downline repurchase points) are skipped. The qualifying actual
 * levels, in depth order, collapse into effective levels 1,2,3,… up to the package
 * reach — so level 1 (5%) is always filled first even if the nearest contributors
 * sit at depth 11. Returns Map<actualLevel, { effectiveLevel, rate }>.
 */
function compressQualifyingLevels(qualifyingActualLevelsSorted, maxReach) {
  const cap = Math.max(0, Math.min(10, Number(maxReach || 0)));
  const map = new Map();
  qualifyingActualLevelsSorted.forEach((actualLevel, idx) => {
    const effectiveLevel = idx + 1;
    if (effectiveLevel > cap) return;
    map.set(Number(actualLevel), { effectiveLevel, rate: UNILEVEL_RATES[effectiveLevel - 1] || 0 });
  });
  return map;
}

/**
 * Recursively collect downline product points per ACTUAL level (depth). Compression
 * is applied afterward in calculateUnilevelForWindow. Scans to MAX_UNILEVEL_SCAN_DEPTH
 * so deep-but-qualifying levels are not missed.
 */
async function calculateUnilevel(parent, level, state, getPointsForUid) {
  if (level > MAX_UNILEVEL_SCAN_DEPTH) return;

  const [rows] = await pool.query(
    'SELECT uid FROM usertab WHERE drefid = ?',
    [parent]
  );

  for (const row of rows) {
    const uidPurchases = Number(await getPointsForUid(row.uid) || 0);
    if (uidPurchases > 0) {
      state.pointsByLevel[level] = (state.pointsByLevel[level] || 0) + uidPurchases;
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
    const selfPoints = await getTotalPointsForRange(uid, start, end, 'unilevel');
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
    maxReach: Number(packagePolicy.unilevelReach || 0) || 0,
    pointsByLevel: {},
  };

  if (state.maxReach <= 0) {
    return 0;
  }

  await calculateUnilevel(uid, 1, state, (memberUid) => getTotalPointsForRange(memberUid, start, end, 'unilevel'));

  // Rollup compression: pay only the first `maxReach` QUALIFYING levels, at the
  // effective-level rates (5/3/3/2/2/1/1/1/1/1%).
  const qualifying = Object.keys(state.pointsByLevel)
    .map(Number)
    .filter((lvl) => state.pointsByLevel[lvl] > 0)
    .sort((a, b) => a - b);
  const compMap = compressQualifyingLevels(qualifying, state.maxReach);

  let total = 0;
  for (const [actualLevel, { rate }] of compMap) {
    total += Number(state.pointsByLevel[actualLevel] || 0) * rate;
  }

  // H1 FIX: do NOT stamp incometransdatetab here. Stamping inside this compute function (on the
  // autocommitting pool) marked the month "settled" BEFORE the caller actually credited the cash —
  // so if the insert threw or the cap zeroed it, the month was lost permanently. The stamp now
  // happens in the caller, in the SAME transaction as the credit, only after the insert succeeds.
  return total;
}

/**
 * Get unilevel income for a user
 * @param {number} uid - User ID
 * @returns {number} Total unilevel income
 */
async function getUnilevel(uid) {
  // Released only on/after the 5th (Manila). Before then no prev-month unilevel is settled.
  if (!isUnilevelReleaseWindow()) return 0;
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

  // Scan deep (collect by ACTUAL level); compression is applied after the scan.
  for (let level = 1; level <= MAX_UNILEVEL_SCAN_DEPTH && parents.length > 0; level += 1) {
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
          AND maintenance_bucket = 'unilevel'
        GROUP BY uid, producttype
        HAVING product_points > 0
        ORDER BY last_transdate DESC`,
      [...childUids, start, end]
    );

    for (const pointRow of pointRows) {
      const source = childByUid.get(Number(pointRow.uid)) || {};
      const points = Number(pointRow.product_points || 0);
      rows.push({
        uid: Number(pointRow.uid || 0),
        username: source.username || null,
        fullname: `${source.firstname || ''} ${source.lastname || ''}`.trim() || source.username || 'Not available',
        actualLevel: level,
        level, // effective level filled in after compression
        producttype: Number(pointRow.producttype || 0),
        productName: PRODUCT_TYPES[Number(pointRow.producttype || 0)] || `Product ${pointRow.producttype}`,
        productPoints: points,
        purchaseCount: Number(pointRow.purchase_count || 0),
        transdate: pointRow.last_transdate,
        rowType: 'downline_product_points',
      });
    }

    parents = childUids;
  }

  // Rollup compression: collapse qualifying actual levels into effective levels
  // 1..maxReach with the effective-level rates; rows beyond reach earn nothing and
  // are dropped from the income breakdown.
  const qualifying = [...new Set(rows.map((r) => r.actualLevel))].sort((a, b) => a - b);
  const compMap = compressQualifyingLevels(qualifying, maxReach);
  const finalRows = [];
  for (const r of rows) {
    const comp = compMap.get(r.actualLevel);
    if (!comp) continue;
    const rate = comp.rate;
    finalRows.push({
      ...r,
      level: comp.effectiveLevel,
      ratePercent: rate * 100,
      amount: r.productPoints * rate,
      projectedAmount: r.productPoints * rate,
    });
  }
  finalRows.sort((a, b) => a.level - b.level || b.productPoints - a.productPoints);

  const totalPoints = finalRows.reduce((sum, row) => sum + Number(row.productPoints || 0), 0);
  const projectedAmount = finalRows.reduce((sum, row) => sum + Number(row.projectedAmount || row.amount || 0), 0);

  return {
    rows: finalRows,
    totalPoints,
    projectedAmount,
    maxReach,
  };
}

module.exports = {
  getUnilevel,
  isUnilevelReleaseWindow,
  UNILEVEL_RELEASE_DAY,
  checkLastMaintenance,
  checkUnilevelTransDate,
  updateIncomeTransDate,
  hasUnilevelCreditedThisMonth,
  getProjectedCurrentMonthUnilevel,
  getUnilevelProductPointContributors,
  getUnilevelRateForLevel,
  getTotalPointsForRange,
  addUnilevelPointsToLevelBucket,
};
