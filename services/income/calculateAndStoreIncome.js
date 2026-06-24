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
const { getUnilevel, checkLastMaintenance, checkUnilevelTransDate, updateIncomeTransDate, hasUnilevelCreditedThisMonth } = require('./unilevel');
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
    // M1 FIX: derive the pairing-cap + package-policy basis from the DB currentaccttype
    // (effective account state), NOT the route session's accttype. A member who upgraded but
    // has not re-logged carried the OLD, lower weekly/monthly cap in the session → pairing
    // under-credited until relogin. The session value is only a fallback now.
    const effectiveAccount = await getEffectiveAccountState(uid);
    const capAccttype = Number(effectiveAccount?.currentaccttype || effectiveAccount?.accttype || 0) || Number(accttype || 0);

    // ── Continuous income (deduplication via Math.max) ───────────────
    const drefResult = await getDREF(uid);
    const pairingResult = await getPairing(uid, capAccttype);
    const leadershipAmount = await getLeadershipBonus(uid);

    const newDref = Math.max(0, drefResult.directreferral - Number(stored.ttlincome1 || 0));
    const newPairing = Math.max(0, pairingResult.totalPay - Number(stored.ttlincome2 || 0));
    // leadership_credit_offset (V037, default 0 for everyone): a fixed per-account forgiveness
    // shift so an account whose paid ttlincome3 exceeds its current engine entitlement can keep
    // earning forward growth. Idempotent — steady state ttlincome3 = engine + offset (bounded).
    const newLeadership = Math.max(
      0,
      leadershipAmount - Number(stored.ttlincome3 || 0) + Number(stored.leadership_credit_offset || 0)
    );
    // Package Hi-Five cash is release-controlled through the claim-review flow.
    // Keep wallet/dashboard calculation from auto-crediting income5, or the same
    // entitlement can be credited again when admin approves the claim.
    const newHifive = 0;

    // ── Monthly income — unilevel (incometype=4) ─────────────────────
    let activeUnilevel = 0;
    if (INCOME_PAYOUT_FLAGS.unilevel) {
      const hasMaintenance = await checkLastMaintenance(uid);
      const alreadyCalcUnilevel = await checkUnilevelTransDate(uid);
      // H2 backstop: in addition to the incometransdatetab stamp, refuse if a unilevel
      // (income4) credit row already exists this calendar month — so a deleted/reset stamp
      // can never re-credit the month (double-pay).
      const alreadyCreditedThisMonth = await hasUnilevelCreditedThisMonth(uid);
      if (hasMaintenance && !alreadyCalcUnilevel && !alreadyCreditedThisMonth) {
        activeUnilevel = await getUnilevel(uid);
      }
    }

    // ── Persist if there is new income ───────────────────────────────
    const capResult = applyLifetimeIncomeCeiling({
      packagePolicy: getPackagePolicy(capAccttype),
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

    if (totalNewIncome >= 1) {
      // C1 FIX (lost-update overpay): re-read the wallet balance FOR UPDATE inside a
      // transaction so a concurrent encashment (which also FOR UPDATEs this row) cannot be
      // lost. Previously income-calc read ttlcashbalance with no row lock and wrote it
      // absolutely (beginning + newIncome) — a debit committed in between was wiped, leaving
      // the member their full balance AND the encashment payout. Holding the row lock from the
      // re-read through COMMIT serializes both money writers on the same row; the fresh balance
      // also keeps the payouthistory beginning/ending snapshot accurate.
      await lockConn.beginTransaction();
      try {
        const [freshRows] = await lockConn.query(
          'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? FOR UPDATE',
          [uid]
        );
        const freshBeginning = Number(freshRows[0]?.ttlcashbalance ?? beginningBalance);
        const freshEnding = freshBeginning + totalNewIncome;
        await insertIncome(uid, {
          dref: allowedIncome.dref,
          paircash: allowedIncome.paircash,
          leadership: allowedIncome.leadership,
          unilevel: allowedIncome.unilevel,
          hifive: allowedIncome.hifive,
          ppctemp: 0,
          pairproduct: 0,
          beginningbalance: freshBeginning,
          endingbalance: freshEnding,
        }, lockConn);
        // H1 FIX: stamp the unilevel monthly guard in the SAME transaction as the credit, and
        // only after the insert succeeded. Previously the stamp was written (autocommit) during
        // getUnilevel BEFORE the credit, so a throw/cap-to-zero left the month marked settled but
        // unpaid → permanent monthly underpay. Now a rolled-back credit also rolls back the stamp.
        if (Number(allowedIncome.unilevel || 0) >= 1) {
          await updateIncomeTransDate(uid, 4, lockConn);
        }
        await lockConn.commit();
      } catch (txErr) {
        await lockConn.rollback();
        throw txErr;
      }
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
      await autoCreditEligibleHiFivePackages(uid);
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
