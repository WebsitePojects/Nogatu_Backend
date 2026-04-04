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

// Match current production behavior: Unilevel and LPC are feature-flagged off.
const ENABLE_UNILEVEL_PAYOUT = false;
const ENABLE_LPC_PAYOUT = false;

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

  // Pairing income eligibility mirrors production ewallet.php rules.
  const [memberRows] = await pool.query(
    'SELECT codeid, cdstatus FROM usertab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const member = memberRows[0] || {};
  const canEarnPairing =
    Number(member.codeid) === 1 ||
    (Number(member.codeid) === 3 && Number(member.cdstatus) === 2);

  // ── Continuous income (deduplication via Math.max) ───────────────
  const drefResult       = await getDREF(uid);
  const pairingResult    = await getPairing(uid, accttype);
  const leadershipAmount = await getLeadershipBonus(uid);

  const newDref       = Math.max(0, drefResult.directreferral  - Number(stored.ttlincome1 || 0));
  const newPairing    = canEarnPairing
    ? Math.max(0, pairingResult.totalPay - Number(stored.ttlincome2 || 0))
    : 0;
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
  let lpcAmount = 0;
  if (ENABLE_LPC_PAYOUT) {
    const alreadyCalcLpc = await checkLpcTransDate(uid);
    if (!alreadyCalcLpc) {
      lpcAmount = await getLPC(uid);
    }
  }

  const activeUnilevel = ENABLE_UNILEVEL_PAYOUT ? unilevelAmount : 0;
  const activeLpc = ENABLE_LPC_PAYOUT ? lpcAmount : 0;

  // ── Persist if there is new income ───────────────────────────────
  const totalNewIncome = newDref + newPairing + newLeadership +
                         activeUnilevel + newHifive + activeLpc;
  const endingBalance  = beginningBalance + totalNewIncome;

  if (totalNewIncome >= 1) {
    await insertIncome(uid, {
      dref:             newDref,
      paircash:         newPairing,
      leadership:       newLeadership,
      unilevel:         activeUnilevel,
      hifive:           newHifive,
      ppctemp:          0,
      lpc:              activeLpc,
      pairproduct:      0,
      beginningbalance: beginningBalance,
      endingbalance:    endingBalance,
    });
  }

  // Save full per-date pairing breakdown so pairingstab mirrors PHP behavior.
  if (pairingResult.dailyReports && pairingResult.dailyReports.length > 0) {
    await savePairingReport(uid, pairingResult.dailyReports);
  }

  // ── Return fresh totals after update ─────────────────────────────
  const [updated] = await pool.query(
    'SELECT * FROM payouttotaltab WHERE uid = ?',
    [uid]
  );
  return updated[0] || {};
}

module.exports = { calculateAndStoreIncome };
