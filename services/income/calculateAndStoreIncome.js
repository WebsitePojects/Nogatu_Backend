/**
 * Shared Income Calculation Service
 *
 * Calculates all income types for a member and persists them to
 * payouttotaltab / payouthistorytab if new income >= 1.
 *
 * Called by BOTH the dashboard route (on every load) and the wallet
 * route — making it idempotent:
 *   - dref / pairing / leadership / hifive: Math.max(0, calc - stored)
 *     → returns 0 if already up-to-date, never double-credits
 *   - unilevel: monthly guard via incometransdatetab incometype=4
 *   - ranking:  income6 is reserved for Ranking Bonus fulfillment
 */
const { pool } = require('../../config/database');
const { getDREF } = require('./directReferral');
const { getPairing, savePairingReport } = require('./pairing');
const { getLeadershipBonus } = require('./leadership');
const { getUnilevel, checkLastMaintenance, checkUnilevelTransDate } = require('./unilevel');
const { insertIncome } = require('./insertIncome');
const { getEffectiveAccountState } = require('../accountState');
const { getPackagePolicy } = require('../packagePolicy');
const { applyLifetimeIncomeCeiling } = require('./incomeCapPolicy');
const { autoCreditEligibleHiFivePackages } = require('./hifiveBonus');

const INCOME_PAYOUT_FLAGS = {
  unilevel: true,
};

/**
 * Run income calculation for a member and persist any new income.
 *
 * @param {number} uid         - Member UID
 * @param {number} accttype    - currentaccttype from session (for pairing caps)
 * @returns {Object}           - Updated payouttotaltab row after calculation
 */
async function calculateAndStoreIncome(uid, accttype) {
  const lockConn = await pool.getConnection();
  const lockKey = `nogatu_income_calc_${Number(uid)}`;

  try {
    const [lockRows] = await lockConn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    if (Number(lockRows[0]?.lockState || 0) !== 1) {
      throw new Error('Unable to acquire income processing lock');
    }

    // Read current stored totals after lock acquisition.
    const [totals] = await lockConn.query(
      'SELECT * FROM payouttotaltab WHERE uid = ?',
      [uid]
    );
    const stored = totals[0] || {};
    const beginningBalance = Number(stored.ttlcashbalance || 0);

    // Production ewallet.php allows all accounts to receive pairing income
    // when eligible source nodes exist on both legs; only source-node
    // contribution is restricted by effective account state.
    await getEffectiveAccountState(uid);

    // ── Continuous income (deduplication via Math.max) ───────────────
    const drefResult = await getDREF(uid);
    const pairingResult = await getPairing(uid, accttype);
    const leadershipAmount = await getLeadershipBonus(uid);

    const newDref = Math.max(0, drefResult.directreferral - Number(stored.ttlincome1 || 0));
    const newPairing = Math.max(0, pairingResult.totalPay - Number(stored.ttlincome2 || 0));
    const newLeadership = Math.max(0, leadershipAmount - Number(stored.ttlincome3 || 0));
    // Package Hi-Five cash is release-controlled through the claim-review flow.
    // Keep wallet/dashboard calculation from auto-crediting income5, or the same
    // entitlement can be credited again when admin approves the claim.
    const newHifive = 0;

    // ── Monthly income — unilevel (incometype=4) ─────────────────────
    let activeUnilevel = 0;
    if (INCOME_PAYOUT_FLAGS.unilevel) {
      const hasMaintenance = await checkLastMaintenance(uid);
      const alreadyCalcUnilevel = await checkUnilevelTransDate(uid);
      if (hasMaintenance && !alreadyCalcUnilevel) {
        activeUnilevel = await getUnilevel(uid);
      }
    }

    // ── Persist if there is new income ───────────────────────────────
    const capResult = applyLifetimeIncomeCeiling({
      packagePolicy: getPackagePolicy(accttype),
      storedTotals: stored,
      proposedIncome: {
        dref: newDref,
        paircash: newPairing,
        leadership: newLeadership,
        unilevel: activeUnilevel,
        hifive: newHifive,
      },
    });

    const allowedIncome = capResult.allowedIncome;
    const totalNewIncome = capResult.allowedTotal;
    const endingBalance = beginningBalance + totalNewIncome;

    if (totalNewIncome >= 1) {
      await insertIncome(uid, {
        dref: allowedIncome.dref,
        paircash: allowedIncome.paircash,
        leadership: allowedIncome.leadership,
        unilevel: allowedIncome.unilevel,
        hifive: allowedIncome.hifive,
        ppctemp: 0,
        pairproduct: 0,
        beginningbalance: beginningBalance,
        endingbalance: endingBalance,
      }, lockConn);
    }

    // Save full per-date pairing breakdown so pairingstab mirrors PHP behavior.
    if (pairingResult.dailyReports && pairingResult.dailyReports.length > 0) {
      await savePairingReport(uid, pairingResult.dailyReports, lockConn);
    }

    // ── Hi-Five package cash — monotonic auto-credit (no claim request) ──────
    // owed = max(0, hifiveEntitlement - ttlincome5). Reconciles legacy/manual hi-five
    // already in ttlincome5 so it never double-pays; new qualifying sets credit here.
    // Runs under the per-uid GET_LOCK held by lockConn (serialized, idempotent).
    try {
      await autoCreditEligibleHiFivePackages(uid, lockConn);
    } catch (hifiveErr) {
      console.error('[Income] hi-five auto-credit failed for uid', uid, hifiveErr.message);
    }

    // ── Return fresh totals after update ─────────────────────────────
    const [updated] = await lockConn.query(
      'SELECT * FROM payouttotaltab WHERE uid = ?',
      [uid]
    );
    return updated[0] || {};
  } finally {
    try {
      await lockConn.query('SELECT RELEASE_LOCK(?)', [lockKey]);
    } catch (releaseErr) {
      // Ignore release failures to avoid masking upstream errors.
    }
    lockConn.release();
  }
}

module.exports = { calculateAndStoreIncome, INCOME_PAYOUT_FLAGS };
