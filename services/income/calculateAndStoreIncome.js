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
 *   - LPC:      monthly guard via incometransdatetab incometype=6
 */
const { pool } = require('../../config/database');
const { getDREF } = require('./directReferral');
const { getPairing, savePairingReport } = require('./pairing');
const { getLeadershipBonus } = require('./leadership');
const { getUnilevel, checkLastMaintenance, checkUnilevelTransDate } = require('./unilevel');
const { getLPC, checkLpcTransDate } = require('./lpc');
const { insertIncome } = require('./insertIncome');

/**
 * Run income calculation for a member and persist any new income.
 *
 * @param {number} uid         - Member UID
 * @param {number} accttype    - currentaccttype from session (for pairing caps)
 * @returns {Object}           - Updated payouttotaltab row after calculation
 */
async function calculateAndStoreIncome(uid, accttype) {
  // Read current stored totals
  const [totals] = await pool.query(
    'SELECT * FROM payouttotaltab WHERE uid = ?',
    [uid]
  );
  const stored = totals[0] || {};
  const beginningBalance = Number(stored.ttlcashbalance || 0);

  // ── Continuous income (deduplication via Math.max) ───────────────
  const drefResult       = await getDREF(uid);
  const pairingResult    = await getPairing(uid, accttype);
  const leadershipAmount = await getLeadershipBonus(uid);

  // Pairing is ONE-TIME ONLY: skip calculation entirely if already credited
  const alreadyPaidPairing = Number(stored.ttlincome2 || 0) > 0;
  const pairingAmount = alreadyPaidPairing ? 0 : await getPairing(uid, accttype);

  const newDref       = Math.max(0, drefResult.directreferral  - Number(stored.ttlincome1 || 0));
  const newPairing    = Math.max(0, pairingResult.totalPay     - Number(stored.ttlincome2 || 0));
  const newLeadership = Math.max(0, leadershipAmount          - Number(stored.ttlincome3 || 0));
  const newHifive     = Math.max(0, drefResult.hifive         - Number(stored.ttlincome5 || 0));

  // ── Monthly income — unilevel (incometype=4) ─────────────────────
  const hasMaintenance     = await checkLastMaintenance(uid);
  const alreadyCalcUnilevel = await checkUnilevelTransDate(uid);
  let unilevelAmount = 0;
  if (hasMaintenance && !alreadyCalcUnilevel) {
    unilevelAmount = await getUnilevel(uid);
  }

  // ── Monthly income — LPC (incometype=6) ──────────────────────────
  const alreadyCalcLpc = await checkLpcTransDate(uid);
  let lpcAmount = 0;
  if (!alreadyCalcLpc) {
    lpcAmount = await getLPC(uid);
  }

  // ── Persist if there is new income ───────────────────────────────
  const totalNewIncome = newDref + newPairing + newLeadership +
                         unilevelAmount + newHifive + lpcAmount;
  const endingBalance  = beginningBalance + totalNewIncome;

  if (totalNewIncome >= 1) {
    await insertIncome(uid, {
      dref:             newDref,
      paircash:         newPairing,
      leadership:       newLeadership,
      unilevel:         unilevelAmount,
      hifive:           newHifive,
      lpc:              lpcAmount,
      beginningbalance: beginningBalance,
      endingbalance:    endingBalance,
    });
  }

  // Save pairing breakdown to pairingstab whenever pairing income exists
  if (pairingResult.totalPay > 0) {
    await savePairingReport(uid, {
      totalleft:       pairingResult.leftCount,
      totalpointsleft: pairingResult.leftPts,
      totalright:      pairingResult.rightCount,
      totalpointsright: pairingResult.rightPts,
      left:            pairingResult.leftPts,
      right:           pairingResult.rightPts,
      totalpoints:     pairingResult.pairedPts,
      totalbpay:       pairingResult.totalPay,
    });
  }

  // ── Return fresh totals after update ─────────────────────────────
  const [updated] = await pool.query(
    'SELECT * FROM payouttotaltab WHERE uid = ?',
    [uid]
  );
  return updated[0] || {};
}

module.exports = { calculateAndStoreIncome };
