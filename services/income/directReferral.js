/**
 * Direct Referral Income Calculation
 * 1:1 port of PHP income-dref-fnc.php :: get_DREF($id)
 *
 * Income Type 1 (income1)
 * - Sums directreferral values from all paid direct referrals
 * - Adds Hi-Five bonus per 5 referrals of same account type
 * - Adds upgrade incentive points from direct referrals
 */
const { pool } = require('../../config/database');
const { getEffectiveAccountState } = require('../accountState');

function toNumber(value) {
  return Number(value || 0);
}

function countsForDirectReferralSource(row) {
  if (!row) return false;

  if (toNumber(row.codeid) === 1) {
    return true;
  }

  if (
    toNumber(row.codeid) === 3 &&
    (
      toNumber(row.cdstatus) === 2 ||
      (toNumber(row.cdamount) > 0 && toNumber(row.cdtotal) >= toNumber(row.cdamount))
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate Direct Referral income for a user
 * @param {number} uid - User ID
 * @returns {Object} { directreferral, bronze, silver, gold, platinum, diamond, amethyst, hifive }
 */
async function getDREF(uid) {
  const result = {
    directreferral: 0,
    bronze: 0,
    silver: 0,
    gold: 0,
    platinum: 0,
    diamond: 0,
    amethyst: 0,
    hifive: 0,
  };

  // Query all direct referrals, then apply latest production effective-state rules.
  const [rows] = await pool.query(
    `SELECT uid, accttype, currentaccttype, directreferral,
            codeid, cdamount, cdtotal, cdstatus
       FROM usertab
      WHERE drefid = ?`,
    [uid]
  );

  let totalDref = 0;
  let countByType = { 10: 0, 20: 0, 30: 0, 40: 0, 50: 0, 60: 0 };

  for (const row of rows) {
    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    if (!countsForDirectReferralSource(effectiveRow)) {
      continue;
    }

    totalDref += Number(effectiveRow.directreferral || 0);
    const acctType = Number(effectiveRow.currentaccttype || effectiveRow.accttype || 0);
    if (Object.prototype.hasOwnProperty.call(countByType, acctType)) {
      countByType[acctType]++;
    }
  }

  // Hi-Five bonus: per 5 referrals of same account type
  result.bronze = Math.floor(countByType[10] / 5) * 2500;
  result.silver = Math.floor(countByType[20] / 5) * 5000;
  result.gold = Math.floor(countByType[30] / 5) * 10000;
  result.platinum = Math.floor(countByType[40] / 5) * 25000;
  result.diamond = Math.floor(countByType[50] / 5) * 50000;
  result.amethyst = Math.floor(countByType[60] / 5) * 150000;

  result.hifive = result.bronze + result.silver + result.gold +
                  result.platinum + result.diamond + result.amethyst;

  // Add upgrade incentive points from direct referrals
  const [upgradeRows] = await pool.query(
    `SELECT SUM(incentivepoints) as ttlIncentive
     FROM upgradetab
     WHERE uid IN (SELECT uid FROM usertab WHERE drefid = ?) AND transtype = 1`,
    [uid]
  );

  const upgradeIncentive = Number(upgradeRows[0]?.ttlIncentive || 0);

  result.directreferral = totalDref + upgradeIncentive;

  return result;
}

module.exports = { getDREF, countsForDirectReferralSource };
