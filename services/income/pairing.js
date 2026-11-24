/**
 * Binary Pairing Income Calculation
 * 1:1 port of PHP income-pairing-fnc.php :: get_pairing($id, $accttype)
 *
 * Income Type 2 (income2)
 * - Traverses binary tree (left/right legs via refid + position)
 * - Calculates paired points = min(left_points, right_points)
 * - Applies weekly caps based on account type
 */
const { pool } = require('../../config/database');
const { getISOWeek } = require('../../utils/helpers');
const { getEffectiveAccountState, countsForPairingSource } = require('../accountState');
const { getBinaryPairingEligibility } = require('../binaryEligibility');
const {
  getPackagePairingDepthLimit,
  getPackagePairingWeeklyCap,
  getPackagePairingMonthlyCap,
  getPackageSealingPoint,
  listPackagePolicies,
} = require('../packagePolicy');

const PAIRING_CAPS = listPackagePolicies().reduce((caps, policy) => {
  caps[policy.packageType] = Number(policy.pairingWeeklyCap || 0);
  return caps;
}, {});

function normalizeToDay(dateValue) {
  if (!dateValue) return null;
  const day = String(dateValue).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day + ' 00:00:00';
}

function monthKeyForDate(dateValue) {
  return String(dateValue).slice(0, 7);
}

// Comp-plan pairing week = Tuesday 00:00 -> Monday 23:59 (Asia/Manila), matching the encashment
// window (services/income/encashmentWindow.js getManilaWeekStartUtc). The weekly SMB cap MUST
// bucket by this Tue-start week, NOT the ISO Monday-start week: using getISOWeek mis-allocated a
// Monday's earnings into the wrong cap window and wrongly sealed pairing (CONFIRMED 2026-06-22 by
// management — e.g. Primavesa's Jun 01 (Mon) belongs to the Tue May 26 week, not the Jun 01 ISO
// week). Pairing groups by whole Manila days, so key each day by the date of the Tuesday that
// starts its week (Manila is a fixed UTC+8 offset, so the calendar-day key is exact).
function pairingWeekKey(dateValue) {
  const ymd = String(dateValue).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  const daysSinceTue = (d.getUTCDay() - 2 + 7) % 7; // JS getUTCDay(): Tue = 2
  d.setUTCDate(d.getUTCDate() - daysSinceTue);
  return d.toISOString().slice(0, 10);
}

/**
 * Carry reset (V052, account ownership handover). Returns the engine day ('YYYY-MM-DD 00:00:00')
 * before which the member's unmatched carry is discarded, or null when the member has no reset.
 * A missing table means the migration has not run, and then no reset row can exist either.
 */
async function getCarryFlushDay(uid, executor = pool) {
  try {
    const [rows] = await executor.query(
      `SELECT DATE_FORMAT(carry_flush_day, '%Y-%m-%d') AS flush_day
         FROM pairing_carry_resettab
        WHERE uid = ?
        LIMIT 1`,
      [uid]
    );
    const day = rows && rows[0] ? rows[0].flush_day : null;
    return day ? `${day} 00:00:00` : null;
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || Number(err.errno) === 1146)) {
      return null;
    }
    throw err;
  }
}

// Engine days come from stored dates (Node-era rows are UTC), so "today" is the UTC calendar day.
function currentEngineDay(now = new Date()) {
  return `${now.toISOString().slice(0, 10)} 00:00:00`;
}

// A reset dated in the future has not happened yet and must not hide carry the member still owns.
function isCarryFlushActive(carryFlushDay, now = new Date()) {
  return Boolean(carryFlushDay) && String(carryFlushDay) <= currentEngineDay(now);
}

function countsTowardPairing(entry) {
  return Number(entry.codeid) === 1 || Number(entry.codeid) === 3;
}

/**
 * Unmatched points left on each leg (the dashboard's "remaining PV"). Matching consumes equal
 * points from both legs, so the carry is the difference of the leg sums; after a reset only the
 * points dated on or after the flush day can still be waiting for a match.
 */
function computeCarry(leftPoints, rightPoints, carryFlushDay, now = new Date()) {
  const flushActive = isCarryFlushActive(carryFlushDay, now);
  const sumLeg = (entries) => entries.reduce((total, entry) => {
    // Undated entries never pair in the engine (lp.date === date is never true), so they never wait.
    if (!countsTowardPairing(entry) || !entry.date) return total;
    if (flushActive && entry.date < carryFlushDay) return total;
    return total + Number(entry.points || 0);
  }, 0);
  const left = sumLeg(leftPoints);
  const right = sumLeg(rightPoints);
  return {
    countedLeft: left,
    countedRight: right,
    carryLeft: Math.max(0, left - right),
    carryRight: Math.max(0, right - left),
  };
}

async function getUpgradeAccounts(uid) {
  const [rows] = await pool.query(
    `SELECT uid,
            DATE_FORMAT(transdate, '%Y-%m-%d') as transdate,
            binarypoints,
            transtype
       FROM upgradetab
      WHERE transtype = 1 AND uid = ?
      ORDER BY transdate ASC, id ASC`,
    [uid]
  );

  return rows;
}

async function appendUpgradePairingBonus(uid, side, leftPoints, rightPoints, allDates, totals) {
  const upgrades = await getUpgradeAccounts(uid);
  if (!upgrades || upgrades.length === 0) {
    return;
  }

  for (const upgrade of upgrades) {
    const upgradeDate = normalizeToDay(upgrade.transdate);
    if (upgradeDate) {
      allDates.add(upgradeDate);
    }

    const upgradeEntry = {
      uid: upgrade.uid,
      points: Number(upgrade.binarypoints || 0),
      date: upgradeDate,
      codeid: Number(upgrade.transtype || 0),
    };

    if (side === 'left') {
      leftPoints.push(upgradeEntry);
      if (totals) {
        totals.totalpointsleft += upgradeEntry.points;
      }
    } else {
      rightPoints.push(upgradeEntry);
      if (totals) {
        totals.totalpointsright += upgradeEntry.points;
      }
    }
  }
}

/**
 * Recursively traverse binary tree to collect binary points by leg.
 * Pairing source eligibility mirrors the live PHP effective-state rules.
 */
async function getNumLevels(
  parent,
  level,
  leftPoints,
  rightPoints,
  allDates,
  sideMap,
  memberAccttype,
  totals,
  pairingDepthLimit
) {
  if (pairingDepthLimit != null && level > pairingDepthLimit) {
    return;
  }

  const [rows] = await pool.query(
    `SELECT uid, refid, drefid, position, codeid, accttype, currentaccttype,
            cdamount, cdtotal, cdstatus, binarypoints,
            DATE_FORMAT(datereg, '%Y-%m-%d %H:%i:%s') as datereg
       FROM usertab
      WHERE refid = ?`,
    [parent]
  );

  for (const baseRow of rows) {
    const row = await getEffectiveAccountState(baseRow.uid, baseRow);
    if (!row) {
      continue;
    }

    const side = level === 1
      ? (Number(row.position) === 1 ? 'left' : 'right')
      : (sideMap[parent] || 'right');
    sideMap[row.uid] = side;

    const isPairingSource = countsForPairingSource(row);
    const baseDate = normalizeToDay(row.datereg);

    if (isPairingSource && baseDate) {
      allDates.add(baseDate);
    }

    if (isPairingSource) {
      const pointEntry = {
        uid: row.uid,
        points: Number(row.binarypoints || 0),
        date: baseDate,
        codeid: Number(row.codeid || 0),
      };

      if (side === 'left') {
        leftPoints.push(pointEntry);
        totals.totalleft += 1;
        totals.totalpointsleft += pointEntry.points;
      } else {
        rightPoints.push(pointEntry);
        totals.totalright += 1;
        totals.totalpointsright += pointEntry.points;
      }

      if (Number(row.accttype || 0) < Number(row.currentaccttype || 0)) {
        await appendUpgradePairingBonus(row.uid, side, leftPoints, rightPoints, allDates, totals);
      }
    }

    await getNumLevels(
      row.uid,
      level + 1,
      leftPoints,
      rightPoints,
      allDates,
      sideMap,
      memberAccttype,
      totals,
      pairingDepthLimit
    );
  }
}

/**
 * Calculate total pairing amount with weekly caps
 */
function totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals, options = {}) {
  const sortedDates = Array.from(allDates).sort();
  const maxPay = getPackagePairingWeeklyCap(accttype) || 10000;
  const monthCap = getPackagePairingMonthlyCap(accttype) || 0;
  const sealingPoint = getPackageSealingPoint(accttype);
  const carryFlushDay = options.carryFlushDay || null;
  let carryFlushed = false;
  let lcounter = 0;
  let rcounter = 0;
  let ttlbpay = 0;
  const weeklyCredits = new Map();
  const monthlyCredits = new Map();

  const dailyReports = [];

  for (const date of sortedDates) {
    // Ownership handover: the previous owner's unmatched carry never pairs after the cutoff.
    // Pairing already earned before it, and the week/month cap usage, are left untouched.
    if (carryFlushDay && !carryFlushed && date >= carryFlushDay) {
      lcounter = 0;
      rcounter = 0;
      carryFlushed = true;
    }

    let leftToday = 0;
    for (const lp of leftPoints) {
      if (lp.date === date && countsTowardPairing(lp)) {
        leftToday += Number(lp.points || 0);
      }
    }

    let rightToday = 0;
    for (const rp of rightPoints) {
      if (rp.date === date && countsTowardPairing(rp)) {
        rightToday += Number(rp.points || 0);
      }
    }

    lcounter += leftToday;
    rcounter += rightToday;

    const reportLeft = lcounter;
    const reportRight = rcounter;

    let ttlcounter;
    if (lcounter < rcounter) {
      ttlcounter = lcounter;
      rcounter = rcounter - lcounter;
      lcounter = 0;
    } else if (rcounter < lcounter) {
      ttlcounter = rcounter;
      lcounter = lcounter - rcounter;
      rcounter = 0;
    } else {
      ttlcounter = rcounter;
      lcounter = 0;
      rcounter = 0;
    }

    const transWeek = Number(getISOWeek(date));
    const monthKey = monthKeyForDate(date);
    const bpay = Number(ttlcounter || 0);
    // Weekly cap bucket = comp-plan Tue 00:00 -> Mon 23:59 Manila week (NOT ISO Mon-Sun).
    const weekKey = pairingWeekKey(date);
    const weekRemaining = Math.max(0, maxPay - Number(weeklyCredits.get(weekKey) || 0));
    const monthRemaining = monthCap > 0
      ? Math.max(0, monthCap - Number(monthlyCredits.get(monthKey) || 0))
      : bpay;
    const weeklyCredited = Math.min(bpay, weekRemaining, monthRemaining);
    const sealingRemaining = sealingPoint > 0 ? Math.max(0, sealingPoint - ttlbpay) : weeklyCredited;
    const newBpayRecord = sealingPoint > 0 ? Math.min(weeklyCredited, sealingRemaining) : weeklyCredited;

    weeklyCredits.set(weekKey, Number(weeklyCredits.get(weekKey) || 0) + newBpayRecord);
    if (monthCap > 0) {
      monthlyCredits.set(monthKey, Number(monthlyCredits.get(monthKey) || 0) + newBpayRecord);
    }
    ttlbpay += newBpayRecord;

    if (reportLeft >= 1 || reportRight >= 1) {
      dailyReports.push({
        transdate: String(date).slice(0, 10),
        totalleft: totals.totalleft,
        totalpointsleft: totals.totalpointsleft,
        totalright: totals.totalright,
        totalpointsright: totals.totalpointsright,
        weeknumber: transWeek,
        left: reportLeft,
        right: reportRight,
        totalpoints: newBpayRecord,
        totalbpay: ttlbpay,
      });
    }
  }

  // The cutoff has passed but no point is dated on or after it yet: the carry is still gone.
  if (carryFlushDay && !carryFlushed) {
    lcounter = 0;
    rcounter = 0;
  }

  return { totalPay: ttlbpay, dailyReports: dailyReports, carryLeft: lcounter, carryRight: rcounter };
}

/**
 * Main pairing calculation
 * @param {number} uid - User ID
 * @param {number} accttype - Account type code (10-60)
 * @returns {{ totalPay, leftCount, leftPts, rightCount, rightPts, pairedPts }} Pairing result
 */
async function getPairing(uid, accttype) {
  const ownerAccount = await getEffectiveAccountState(uid);
  if (!ownerAccount) {
    return {
      totalPay: 0,
      leftCount: 0,
      leftPts: 0,
      rightCount: 0,
      rightPts: 0,
      pairedPts: 0,
      dailyReports: [],
    };
  }

  // Production pairing payout is driven by whether descendant source nodes are
  // pairing-eligible. An unpaid CD owner cannot pass their own BP upward, but
  // can still receive pairing from eligible downlines on both legs.

  const leftPoints = [];
  const rightPoints = [];
  const allDates = new Set();
  const sideMap = {};
  const totals = {
    totalleft: 0,
    totalpointsleft: 0,
    totalright: 0,
    totalpointsright: 0,
  };
  const pairingDepthLimit = getPackagePairingDepthLimit(accttype);

  await getNumLevels(uid, 1, leftPoints, rightPoints, allDates, sideMap, accttype, totals, pairingDepthLimit);

  const leftPts = leftPoints.reduce(function sumPoints(total, point) {
    return total + Number(point.points || 0);
  }, 0);
  const rightPts = rightPoints.reduce(function sumPoints(total, point) {
    return total + Number(point.points || 0);
  }, 0);
  const pairedPts = Math.min(leftPts, rightPts);
  const eligibility = await getBinaryPairingEligibility(uid);
  const carryFlushDay = await getCarryFlushDay(uid);
  const carry = computeCarry(leftPoints, rightPoints, carryFlushDay);

  if (allDates.size === 0) {
    return {
      totalPay: 0,
      leftCount: totals.totalleft,
      leftPts,
      rightCount: totals.totalright,
      rightPts,
      pairedPts,
      dailyReports: [],
      eligibility,
      carryFlushDay,
      ...carry,
    };
  }

  if (!eligibility.canEarnPairing) {
    return {
      totalPay: 0,
      leftCount: totals.totalleft,
      leftPts,
      rightCount: totals.totalright,
      rightPts,
      pairedPts,
      dailyReports: [],
      eligibility,
      carryFlushDay,
      ...carry,
    };
  }

  const pairingResult = totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals, {
    carryFlushDay: isCarryFlushActive(carryFlushDay) ? carryFlushDay : null,
  });

  return {
    totalPay: pairingResult.totalPay,
    leftCount: totals.totalleft,
    leftPts: leftPts,
    rightCount: totals.totalright,
    rightPts: rightPts,
    pairedPts: pairedPts,
    dailyReports: pairingResult.dailyReports,
    eligibility,
    carryFlushDay,
    ...carry,
  };
}

/**
 * Leg PV for display on an account whose carry was reset. Counts only the points dated from the
 * reset day, with the same engine the wallet uses, so the "unmatched PV" shown to the new owner is
 * exactly what can still pay. Returns null for every account without an active reset, and the
 * caller keeps its usual figures.
 */
async function getCarryResetLegPoints(uid) {
  const carryFlushDay = await getCarryFlushDay(uid);
  if (!isCarryFlushActive(carryFlushDay)) {
    return null;
  }
  const account = await getEffectiveAccountState(uid);
  const accttype = Number(account?.currentaccttype || account?.accttype || 0);
  const result = await getPairing(uid, accttype);
  return {
    carryFlushDay,
    totalPointsLeft: Number(result.countedLeft || 0),
    totalPointsRight: Number(result.countedRight || 0),
  };
}

/**
 * Get pairing report data for display
 */
async function getPairingReport(uid) {
  const [rows] = await pool.query(
    `SELECT id, uid, DATE_FORMAT(transdate, '%Y-%m-%d') as transdate,
            totalleft, totalpointsleft, totalright, totalpointsright,
            \`left\`, \`right\`, totalpoints, totalbpay
     FROM pairingstab WHERE uid = ? ORDER BY transdate DESC, id DESC`,
    [uid]
  );

  return rows;
}

/**
 * Insert/update pairing report records per day
 */
async function savePairingReport(uid, reports, conn = pool) {
  if (!Array.isArray(reports) || reports.length === 0) return;

  for (const report of reports) {
    const transDate = String(report.transdate).slice(0, 10);
    const [existing] = await conn.query(
      `SELECT id FROM pairingstab
        WHERE uid = ? AND DATE_FORMAT(transdate, '%Y-%m-%d') = ?
        LIMIT 1`,
      [uid, transDate]
    );

    if (existing.length > 0) {
      await conn.query(
        `UPDATE pairingstab
            SET transdate = ?,
                totalleft = ?,
                totalpointsleft = ?,
                totalright = ?,
                totalpointsright = ?,
                weeknumber = ?,
                \`left\` = ?,
                \`right\` = ?,
                totalpoints = ?,
                totalbpay = ?
          WHERE uid = ?
            AND DATE_FORMAT(transdate, '%Y-%m-%d') = ?`,
        [
          transDate,
          report.totalleft,
          report.totalpointsleft,
          report.totalright,
          report.totalpointsright,
          report.weeknumber,
          report.left,
          report.right,
          report.totalpoints,
          report.totalbpay,
          uid,
          transDate,
        ]
      );
      continue;
    }

    try {
      await conn.query(
        `INSERT INTO pairingstab
         (uid, transdate, totalleft, totalpointsleft, totalright, totalpointsright,
          weeknumber, \`left\`, \`right\`, totalpoints, totalbpay)
         VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid,
          transDate,
          report.totalleft,
          report.totalpointsleft,
          report.totalright,
          report.totalpointsright,
          report.weeknumber,
          report.left,
          report.right,
          report.totalpoints,
          report.totalbpay,
        ]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        await conn.query(
          `UPDATE pairingstab
              SET transdate = ?,
                  totalleft = ?,
                  totalpointsleft = ?,
                  totalright = ?,
                  totalpointsright = ?,
                  weeknumber = ?,
                  \`left\` = ?,
                  \`right\` = ?,
                  totalpoints = ?,
                  totalbpay = ?
            WHERE uid = ?`,
          [
            transDate,
            report.totalleft,
            report.totalpointsleft,
            report.totalright,
            report.totalpointsright,
            report.weeknumber,
            report.left,
            report.right,
            report.totalpoints,
            report.totalbpay,
            uid,
          ]
        );
      } else {
        throw err;
      }
    }
  }
}

module.exports = {
  getPairing,
  getPairingReport,
  savePairingReport,
  totalPairingAmount,
  pairingWeekKey,
  PAIRING_CAPS,
  getCarryFlushDay,
  getCarryResetLegPoints,
  computeCarry,
  isCarryFlushActive,
};
