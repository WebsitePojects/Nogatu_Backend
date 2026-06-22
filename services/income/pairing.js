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
function totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals) {
  const sortedDates = Array.from(allDates).sort();
  const maxPay = getPackagePairingWeeklyCap(accttype) || 10000;
  const monthCap = getPackagePairingMonthlyCap(accttype) || 0;
  const sealingPoint = getPackageSealingPoint(accttype);
  let lcounter = 0;
  let rcounter = 0;
  let ttlbpay = 0;
  const weeklyCredits = new Map();
  const monthlyCredits = new Map();

  const dailyReports = [];

  for (const date of sortedDates) {
    let leftToday = 0;
    for (const lp of leftPoints) {
      if (lp.date === date && (Number(lp.codeid) === 1 || Number(lp.codeid) === 3)) {
        leftToday += Number(lp.points || 0);
      }
    }

    let rightToday = 0;
    for (const rp of rightPoints) {
      if (rp.date === date && (Number(rp.codeid) === 1 || Number(rp.codeid) === 3)) {
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

  return { totalPay: ttlbpay, dailyReports: dailyReports };
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
    };
  }

  const pairingResult = totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals);

  return {
    totalPay: pairingResult.totalPay,
    leftCount: totals.totalleft,
    leftPts: leftPts,
    rightCount: totals.totalright,
    rightPts: rightPts,
    pairedPts: pairedPts,
    dailyReports: pairingResult.dailyReports,
    eligibility,
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

module.exports = { getPairing, getPairingReport, savePairingReport, totalPairingAmount, pairingWeekKey, PAIRING_CAPS };
