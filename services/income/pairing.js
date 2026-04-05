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

// Weekly pairing caps by account type
const PAIRING_CAPS = {
  10: 10000,   // Bronze
  20: 20000,   // Silver
  30: 40000,   // Gold
  40: 80000,   // Platinum
  50: 150000,  // Garnet
  60: 300000,  // Diamond
};

function normalizeToDay(dateValue) {
  if (!dateValue) return null;
  const day = String(dateValue).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day} 00:00:00`;
}

async function getUpgradeAccount(uid) {
  const [rows] = await pool.query(
    `SELECT uid,
            DATE_FORMAT(transdate, '%Y-%m-%d') as transdate,
            binarypoints,
            transtype
       FROM upgradetab
      WHERE transtype = 1 AND uid = ?
      LIMIT 1`,
    [uid]
  );

  return rows[0] || null;
}

/**
 * Recursively traverse binary tree to collect binary points by leg.
 * Only PD accounts (codeid=1) are counted — all tiers contribute to pairing.
 */
async function getNumLevels(
  parent,
  level,
  leftPoints,
  rightPoints,
  allDates,
  sideMap,
  memberAccttype,
  totals
) {
  const [rows] = await pool.query(
    `SELECT uid, refid, position, codeid, accttype, currentaccttype, binarypoints,
            DATE_FORMAT(datereg, '%Y-%m-%d %H:%i:%s') as datereg
       FROM usertab
      WHERE refid = ?`,
    [parent]
  );

  for (const row of rows) {
    const side = level === 1
      ? (Number(row.position) === 1 ? 'left' : 'right')
      : (sideMap[parent] || 'right');
    sideMap[row.uid] = side;

    const isPD = Number(row.codeid) === 1;
    const baseDate = normalizeToDay(row.datereg);

    if (isPD && baseDate) {
      allDates.add(baseDate);
    }

    if (isPD) {
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

      // Upgrade points are added as extra same-leg entries when account was upgraded.
      if (Number(row.accttype || 0) < Number(row.currentaccttype || 0)) {
        const upgrade = await getUpgradeAccount(row.uid);
        if (upgrade) {
          const upgradeDate = normalizeToDay(upgrade.transdate);
          if (upgradeDate) {
            allDates.add(upgradeDate);
            const upgradeEntry = {
              uid: upgrade.uid,
              points: Number(upgrade.binarypoints || 0),
              date: upgradeDate,
              codeid: Number(upgrade.transtype || 0),
            };
            if (side === 'left') {
              leftPoints.push(upgradeEntry);
            } else {
              rightPoints.push(upgradeEntry);
            }
          }
        }
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
      totals
    );
  }
}

/**
 * Calculate total pairing amount with weekly caps
 */
function totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals) {
  const sortedDates = [...allDates].sort();
  const maxPay = PAIRING_CAPS[accttype] || 10000;
  let lcounter = 0;
  let rcounter = 0;

  let startWeek = null;
  let newbpay = 0;
  let ttlbpay = 0;
  let ttlbpayTemp = 0;
  let weekBpay = 0;

  const dailyReports = [];

  for (const date of sortedDates) {
    let leftToday = 0;
    for (const lp of leftPoints) {
      if (lp.date === date && Number(lp.codeid) === 1) {
        leftToday += Number(lp.points || 0);
      }
    }

    let rightToday = 0;
    for (const rp of rightPoints) {
      if (rp.date === date && Number(rp.codeid) === 1) {
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
    if (startWeek === null) {
      startWeek = transWeek;
    }

    let newBpayRecord = 0;
    const bpay = Number(ttlcounter || 0);

    if (startWeek === transWeek) {
      newbpay += bpay;

      if (newbpay < maxPay && weekBpay < maxPay) {
        ttlbpay += bpay;
        ttlbpayTemp += bpay;
        weekBpay += bpay;
        newBpayRecord = bpay;
      } else if (newbpay >= maxPay && weekBpay < maxPay) {
        ttlbpayTemp += bpay;

        if (ttlbpayTemp >= maxPay) {
          const newMaxPay = maxPay - weekBpay;
          if (newMaxPay > 0) {
            ttlbpay += newMaxPay;
            weekBpay += newMaxPay;
            newBpayRecord = newMaxPay;
          }
        } else {
          const newMaxPay = maxPay - ttlbpayTemp;
          if (newMaxPay > 0) {
            ttlbpay += newMaxPay;
            weekBpay += newMaxPay;
            newBpayRecord = newMaxPay;
          }
        }
      }
    } else {
      // New week reset mirrors production logic.
      newbpay = 0;
      ttlbpayTemp = 0;
      weekBpay = 0;

      newbpay += bpay;
      if (newbpay < maxPay) {
        ttlbpay += bpay;
        ttlbpayTemp += bpay;
        weekBpay += bpay;
        newBpayRecord = bpay;
      } else {
        ttlbpay += maxPay;
        ttlbpayTemp += maxPay;
        weekBpay += maxPay;
        newBpayRecord = maxPay;
      }
    }

    startWeek = transWeek;

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

  return { totalPay: ttlbpay, dailyReports };
}

/**
 * Main pairing calculation
 * @param {number} uid - User ID
 * @param {number} accttype - Account type code (10-60)
 * @returns {{ totalPay, leftCount, leftPts, rightCount, rightPts, pairedPts }} Pairing result
 */
async function getPairing(uid, accttype) {
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

  await getNumLevels(uid, 1, leftPoints, rightPoints, allDates, sideMap, accttype, totals);

  if (allDates.size === 0) {
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

  const leftPts  = leftPoints.reduce((s, p) => s + p.points, 0);
  const rightPts = rightPoints.reduce((s, p) => s + p.points, 0);
  const pairedPts = Math.min(leftPts, rightPts);
  const pairingResult = totalPairingAmount(leftPoints, rightPoints, allDates, accttype, totals);

  return {
    totalPay: pairingResult.totalPay,
    leftCount:  leftPoints.length,
    leftPts,
    rightCount: rightPoints.length,
    rightPts,
    pairedPts,
    dailyReports: pairingResult.dailyReports,
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
     FROM pairingstab WHERE uid = ? ORDER BY id DESC`,
    [uid]
  );

  return rows;
}

/**
 * Insert/update pairing report records per day
 */
async function savePairingReport(uid, reports) {
  if (!Array.isArray(reports) || reports.length === 0) return;

  for (const report of reports) {
    const transDate = String(report.transdate).slice(0, 10);
    const [existing] = await pool.query(
      `SELECT id FROM pairingstab
        WHERE uid = ? AND DATE_FORMAT(transdate, '%Y-%m-%d') = ?
        LIMIT 1`,
      [uid, transDate]
    );

    if (existing.length > 0) {
      await pool.query(
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
          WHERE id = ?`,
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
          existing[0].id,
        ]
      );
      continue;
    }

    try {
      await pool.query(
        `INSERT INTO pairingstab
         (id, uid, transdate, totalleft, totalpointsleft, totalright, totalpointsright,
          weeknumber, \`left\`, \`right\`, totalpoints, totalbpay)
         VALUES
         (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // Fallback for environments with unique uid constraint on pairingstab.
        await pool.query(
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

module.exports = { getPairing, getPairingReport, savePairingReport, PAIRING_CAPS };
