/**
 * Direct Referral Income Calculation
 * 1:1 port of PHP income-dref-fnc.php :: get_DREF($id)
 *
 * Income Type 1 (income1)
 * - Sums directreferral values from all package-entry direct referrals
 * - Adds Hi-Five bonus per 5 referrals of same account type
 * - Adds upgrade incentive points from direct referrals
 */
const { pool } = require('../../config/database');
const {
  getEffectiveAccountState,
  countsForDirectReferralSource,
} = require('../accountState');

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
  const eligibleDirectUids = []; // M2: upgrade incentive must follow the same per-row eligibility

  for (const row of rows) {
    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    if (!countsForDirectReferralSource(effectiveRow)) {
      continue;
    }
    eligibleDirectUids.push(Number(row.uid));

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

  // M2 FIX: add upgrade-incentive points ONLY from directs that ALSO pass the per-row
  // eligibility filter above. Previously this summed incentives for ALL directs (drefid=?)
  // regardless of countsForDirectReferralSource, so FS / unpaid-CD directs' upgrade incentives
  // still inflated the sponsor's DR (over-pay). Now it mirrors the totalDref eligibility.
  let upgradeIncentive = 0;
  if (eligibleDirectUids.length > 0) {
    const placeholders = eligibleDirectUids.map(() => '?').join(',');
    const [upgradeRows] = await pool.query(
      `SELECT SUM(incentivepoints) as ttlIncentive
       FROM upgradetab
       WHERE uid IN (${placeholders}) AND transtype = 1`,
      eligibleDirectUids
    );
    upgradeIncentive = Number(upgradeRows[0]?.ttlIncentive || 0);
  }

  result.directreferral = totalDref + upgradeIncentive;

  return result;
}

module.exports = { getDREF, countsForDirectReferralSource };
