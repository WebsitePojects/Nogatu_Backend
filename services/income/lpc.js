/**
 * LPC (Last Month Pairing Commission) Calculation
 * 1:1 port of PHP income-lpc-fnc.php :: get_lpc($id)
 *
 * Income Type 6 (income6)
 * - 10% of each downline member's previous month pairing
 * - Capped at 1000 per week per member
 * - Traverses entire downline recursively via drefid
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
 * Calculate LPC for a user
 * @param {number} uid - User ID
 * @returns {number} Total LPC income
 */
async function getLPC(uid) {
  const members = [];
  await getDownlineMembers(uid, members);

  let totalLpc = 0;

  for (const memberUid of members) {
    const pairingTotal = await getLpcPairing(memberUid);

    if (pairingTotal > 0) {
      // 10% commission, capped at 1000 per week
      let weeklyLpc = pairingTotal * 0.1;
      weeklyLpc = Math.min(weeklyLpc, 1000);
      totalLpc += weeklyLpc;
    }
  }

  return totalLpc;
}

module.exports = { getLPC };
