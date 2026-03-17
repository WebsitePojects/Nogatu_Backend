/**
 * LPC (Last Month Pairing Commission) Calculation
 * Mirrors PHP income-lpc-fnc.php :: get_lpc($id)
 *
 * Income Type 6 (income6)
 * - 10% of each downline member's previous month pairing
 * - Capped at 1000 per member
 * - Traverses entire downline recursively via drefid (sponsor tree)
 * - Calculated ONCE PER MONTH — guarded by incometransdatetab incometype=6
 */
const { pool } = require('../../config/database');
const { previousMonthRange } = require('../../utils/helpers');

/**
 * Get previous month pairing total for a specific user
 * Mirrors PHP get_lpcpairing()
 */
async function getLpcPairing(uid) {
  const { start, end } = previousMonthRange();

  const [rows] = await pool.query(
    `SELECT SUM(totalpoints) as ttlpoints
     FROM pairingstab
     WHERE uid = ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?`,
    [uid, start, end]
  );

  return Number(rows[0]?.ttlpoints || 0);
}

/**
 * Recursively traverse downline via drefid to collect all member UIDs
 * Mirrors PHP get_numlevels() for LPC
 */
async function getDownlineMembers(parent, members) {
  const [rows] = await pool.query(
    'SELECT uid FROM usertab WHERE drefid = ?',
    [parent]
  );

  for (const row of rows) {
    members.push(row.uid);
    await getDownlineMembers(row.uid, members);
  }
}

/**
 * Check if LPC has already been calculated this month
 * Mirrors PHP chkIncometransdate6() — uses CURRENT month range (not previous)
 */
async function checkLpcTransDate(uid) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const sdate = `${year}-${month}-01`;
  const edate = new Date(year, now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const [rows] = await pool.query(
    `SELECT uid FROM incometransdatetab
     WHERE uid = ? AND incometype = 6
       AND DATE_FORMAT(lasttransdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(lasttransdate, '%Y-%m-%d') <= ?`,
    [uid, sdate, edate]
  );

  return rows.length > 0 ? 1 : 0;
}

/**
 * Record that LPC was calculated this month
 * Mirrors PHP updIncometransdate6()
 */
async function updateLpcTransDate(uid) {
  await pool.query(
    `INSERT INTO incometransdatetab (uid, incometype, lasttransdate)
     VALUES (?, 6, NOW())`,
    [uid]
  );
}

/**
 * Calculate LPC for a user
 * Includes monthly guard — returns 0 if already calculated this month
 * @param {number} uid - User ID
 * @returns {number} Total LPC income
 */
async function getLPC(uid) {
  // Monthly guard: LPC is calculated once per month
  const alreadyCalculated = await checkLpcTransDate(uid);
  if (alreadyCalculated) return 0;

  const members = [];
  await getDownlineMembers(uid, members);

  let totalLpc = 0;

  for (const memberUid of members) {
    const pairingTotal = await getLpcPairing(memberUid);

    if (pairingTotal > 0) {
      // 10% commission, capped at 1000 per member
      let lpc = pairingTotal * 0.1;
      lpc = Math.min(lpc, 1000);
      totalLpc += lpc;
    }
  }

  // Mark as calculated this month to prevent repeat on next page load
  if (totalLpc > 0) {
    await updateLpcTransDate(uid);
  }

  return totalLpc;
}

module.exports = { getLPC, checkLpcTransDate };
