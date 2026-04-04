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
const { arraySort } = require('../../utils/arraySort');
const { getISOWeek, nowMySQL } = require('../../utils/helpers');

// Weekly pairing caps by account type
const PAIRING_CAPS = {
  10: 10000,   // Bronze
  20: 20000,   // Silver
  30: 40000,   // Gold
  40: 80000,   // Platinum
  50: 150000,  // Garnet
  60: 300000,  // Diamond
};

/**
 * Recursively traverse binary tree to collect binary points by leg.
 * Only PD accounts (codeid=1) of the same tier as the member (memberAccttype) are counted.
 */
async function getNumLevels(parent, level, leftPoints, rightPoints, allDates, memberAccttype) {
  const [rows] = await pool.query(
    'SELECT uid, refid, position, codeid, currentaccttype, binarypoints, DATE_FORMAT(datereg, "%Y-%m-%d %H:%i:%s") as datereg FROM usertab WHERE refid = ?',
    [parent]
  );

  for (const row of rows) {
    const bp = Number(row.binarypoints || 0);
    const dateKey = row.datereg;
    const isSameTierPD = Number(row.codeid) === 1 && Number(row.currentaccttype) === Number(memberAccttype);

    if (level === 1) {
      // Level 1: direct children determine left/right assignment
      if (Number(row.position) === 1) {
        // Left leg (position A) — only count same-tier PD accounts
        if (isSameTierPD) leftPoints.push({ uid: row.uid, points: bp, date: dateKey });
        await getNumLevels(row.uid, 2, leftPoints, rightPoints, allDates, memberAccttype);
      } else {
        // Right leg (position B) — only count same-tier PD accounts
        if (isSameTierPD) rightPoints.push({ uid: row.uid, points: bp, date: dateKey });
        await getNumLevels(row.uid, 2, leftPoints, rightPoints, allDates, memberAccttype);
      }
    } else {
      // Level 2+: inherit the leg from parent — only count same-tier PD accounts
      const isLeft = leftPoints.some(p => p.uid === parent);
      if (isSameTierPD) {
        if (isLeft) {
          leftPoints.push({ uid: row.uid, points: bp, date: dateKey });
        } else {
          rightPoints.push({ uid: row.uid, points: bp, date: dateKey });
        }
      }
      await getNumLevels(row.uid, level + 1, leftPoints, rightPoints, allDates, memberAccttype);
    }

    if (isSameTierPD && dateKey && !allDates.includes(dateKey)) {
      allDates.push(dateKey);
    }
  }
}

/**
 * Calculate total pairing amount with weekly caps
 */
function totalPairingAmount(leftPoints, rightPoints, allDates, accttype) {
  // Sort dates ascending
  const sortedDates = [...allDates].sort();

  const maxPay = PAIRING_CAPS[accttype] || 10000;
  let totalBPay = 0;
  let weeklyPay = {};

  for (const date of sortedDates) {
    // Sum left points up to and including this date
    let leftSum = 0;
    for (const lp of leftPoints) {
      if (lp.date <= date) leftSum += lp.points;
    }

    // Sum right points up to and including this date
    let rightSum = 0;
    for (const rp of rightPoints) {
      if (rp.date <= date) rightSum += rp.points;
    }

    // Pairing = min(left, right) * amount per point
    const paired = Math.min(leftSum, rightSum);
    const pairingAmount = paired; // Points are already in monetary value (250 per Bronze, etc.)

    // Apply weekly cap
    const weekNum = getISOWeek(date);
    const yearWeek = `${new Date(date).getFullYear()}-${weekNum}`;

    if (!weeklyPay[yearWeek]) weeklyPay[yearWeek] = 0;

    const remaining = maxPay - weeklyPay[yearWeek];
    if (remaining > 0) {
      const payout = Math.min(pairingAmount - totalBPay, remaining);
      if (payout > 0) {
        weeklyPay[yearWeek] += payout;
        totalBPay += payout;
      }
    }
  }

  return totalBPay;
}

/**
 * Main pairing calculation
 * @param {number} uid - User ID
 * @param {number} accttype - Account type code (10-60)
 * @returns {number} Total pairing income
 */
async function getPairing(uid, accttype) {
  const leftPoints = [];
  const rightPoints = [];
  const allDates = [];

  await getNumLevels(uid, 1, leftPoints, rightPoints, allDates, accttype);

  if (allDates.length === 0) return 0;

  const totalPay = totalPairingAmount(leftPoints, rightPoints, allDates, accttype);

  return totalPay;
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
 * Insert/update pairing report record
 */
async function savePairingReport(uid, data) {
  await pool.query(
    `INSERT INTO pairingstab (id, uid, transdate, totalleft, totalpointsleft,
     totalright, totalpointsright, \`left\`, \`right\`, totalpoints, totalbpay)
     VALUES (NULL, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
     totalleft = VALUES(totalleft), totalpointsleft = VALUES(totalpointsleft),
     totalright = VALUES(totalright), totalpointsright = VALUES(totalpointsright),
     \`left\` = VALUES(\`left\`), \`right\` = VALUES(\`right\`),
     totalpoints = VALUES(totalpoints), totalbpay = VALUES(totalbpay),
     transdate = NOW()`,
    [uid, data.totalleft, data.totalpointsleft, data.totalright,
     data.totalpointsright, data.left, data.right, data.totalpoints, data.totalbpay]
  );
}

module.exports = { getPairing, getPairingReport, savePairingReport, PAIRING_CAPS };
