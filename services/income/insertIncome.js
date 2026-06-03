/**
 * Income Insertion and Encashment
 * 1:1 port of PHP insert-income.php
 *
 * Handles:
 * - insert_Income(): Records income to payouthistorytab and payouttotaltab
 * - insert_Encashment(): Processes cash withdrawals with tax/fee/CD deductions
 */
const { pool } = require('../../config/database');
const { nowMySQL } = require('../../utils/helpers');
const { getEffectiveAccountState } = require('../accountState');
const {
  calculateEncashmentBreakdown,
  validatePayoutDetails,
} = require('../../utils/finance');
const {
  createProcessKey,
  createPublicId,
  maskSensitiveValue,
} = require('../../utils/security');
const { writeAuditLog } = require('../audit');
const { resolvePayoutOption } = require('../payoutOptions');

function getNextPayoutDate(baseDate = new Date()) {
  const payoutDate = new Date(baseDate);
  payoutDate.setHours(0, 0, 0, 0);

  const day = payoutDate.getDay();
  let daysToFriday = (5 - day + 7) % 7;

  // Tuesday cutoff: requests from Wed/Thu/Fri are paid out next week.
  if (day === 3 || day === 4 || day === 5) {
    daysToFriday += 7;
  }
  if (daysToFriday === 0) {
    daysToFriday = 7;
  }

  payoutDate.setDate(payoutDate.getDate() + daysToFriday);
  return payoutDate;
}

/**
 * Insert income record
 * @param {number} uid - User ID
 * @param {Object} income - Income breakdown object
 *   { dref, paircash, leadership, unilevel, hifive, beginningbalance, endingbalance }
 *   income6 is reserved for Ranking Bonus fulfillment and is not written by the shared income calculator.
 */
async function insertIncome(uid, income) {
  const {
    dref = 0,
    paircash = 0,
    leadership = 0,
    unilevel = 0,
    hifive = 0,
    ppctemp = 0,
    pairproduct = 0,
    beginningbalance = 0,
    endingbalance = 0,
  } = income;

  const now = nowMySQL();

  // Insert into payouthistorytab (transaction history)
  await pool.query(
    `INSERT INTO payouthistorytab
     (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
      income1, income2, income3, income4, income5, income6,
      income7, income8, income9, income10,
      encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
      cashstatus, transdate, transactiontype, stockistid, processid)
     VALUES (NULL, ?, NULL, ?, ?, 0,
      ?, ?, ?, ?, ?, ?,
      0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, ?, 1, 0, NULL)`,
    [uid, beginningbalance, endingbalance,
     dref, paircash, leadership, unilevel, hifive, 0, now]
  );

  // Upsert into payouttotaltab (cumulative totals)
  await pool.query(
    `INSERT INTO payouttotaltab
     (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome51, ttlincome6,
      ttlcashbalance, ttlpointsbalance, transdate)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      ttlincome1 = ttlincome1 + VALUES(ttlincome1),
      ttlincome2 = ttlincome2 + VALUES(ttlincome2),
      ttlincome3 = ttlincome3 + VALUES(ttlincome3),
      ttlincome4 = ttlincome4 + VALUES(ttlincome4),
      ttlincome5 = ttlincome5 + VALUES(ttlincome5),
      ttlincome51 = VALUES(ttlincome51),
      ttlincome6 = ttlincome6 + VALUES(ttlincome6),
      ttlcashbalance = VALUES(ttlcashbalance),
      ttlpointsbalance = ttlpointsbalance + VALUES(ttlpointsbalance),
      transdate = VALUES(transdate)`,
    [uid, dref, paircash, leadership, unilevel, hifive, ppctemp, 0, endingbalance, pairproduct, now]
  );

  return true;
}

async function getEncashmentPreview(uid, encashmentAmount, userInfo, conn = pool) {
  const amount = Number(encashmentAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid encashment amount');
  }

  const [balanceRows] = await conn.query(
    'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const currentBalance = Number(balanceRows[0]?.ttlcashbalance || 0);

  const [profileRows] = await conn.query(
    `SELECT u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
            m.payoutid, m.payoutdetails
     FROM usertab u
     LEFT JOIN memberstab m ON m.uid = u.uid
     WHERE u.uid = ?
     LIMIT 1`,
    [uid]
  );
  const rawProfile = { ...(userInfo || {}), ...(profileRows[0] || {}) };
  const profile = await getEffectiveAccountState(uid, rawProfile, conn) || rawProfile;
  const payoutValidation = validatePayoutDetails({
    payoutId: profile.payoutid,
    payoutDetails: profile.payoutdetails,
  });

  const isCdDeductionActive = (
    Number(profile.codeid) === 3 &&
    Number(profile.cdstatus) === 1 &&
    Number(profile.cdamount || 0) > Number(profile.cdtotal || 0)
  );
  const cdRemaining = isCdDeductionActive
    ? Number(profile.cdamount || 0) - Number(profile.cdtotal || 0)
    : 0;
  const breakdown = calculateEncashmentBreakdown({
    amount,
    cdRemaining,
    isCdDeductionActive,
  });

  return {
    amount,
    currentBalance,
    sufficientBalance: amount <= currentBalance,
    payout: payoutValidation,
    deductions: {
      tax: breakdown.tax,
      processingFee: breakdown.processingFee,
      maintenanceFee: breakdown.maintenanceFee,
      cdDeduction: breakdown.cdDeduction,
      total: breakdown.totalDeductions,
    },
    gross: breakdown.gross,
    net: breakdown.net,
    newBalance: currentBalance - amount,
    paymentOptionId: Number(profile.payoutid || 0) || null,
    paymentOption: resolvePayoutOption(profile.payoutid, { allowUnknown: true })?.label || null,
    paymentDetailsMasked: maskSensitiveValue(profile.payoutdetails),
    asOf: new Date().toISOString(),
  };
}

/**
 * Process encashment (cash withdrawal)
 * @param {number} uid - User ID
 * @param {number} encashmentAmount - Amount to withdraw
 * @param {Object} userInfo - { codeid, cdstatus, cdamount, cdtotal }
 * @returns {Object} Encashment result details
 */
async function insertEncashment(uid, encashmentAmount, userInfo, options = {}) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [balanceRows] = await conn.query(
      'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? FOR UPDATE',
      [uid]
    );

    const currentBalance = Number(balanceRows[0]?.ttlcashbalance || 0);
    if (encashmentAmount > currentBalance || encashmentAmount <= 0) {
      throw new Error('Invalid encashment amount');
    }

    const [profileRows] = await conn.query(
      `SELECT u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
              m.payoutid, m.payoutdetails
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
       WHERE u.uid = ?
       LIMIT 1
       FOR UPDATE`,
      [uid]
    );
    const rawProfile = { ...(userInfo || {}), ...(profileRows[0] || {}) };
    const profile = await getEffectiveAccountState(uid, rawProfile, conn) || rawProfile;
    const payoutValidation = validatePayoutDetails({
      payoutId: profile.payoutid,
      payoutDetails: profile.payoutdetails,
    });
    if (!payoutValidation.ok) {
      const error = new Error(payoutValidation.message);
      error.code = payoutValidation.code;
      error.statusCode = 422;
      throw error;
    }

    const isCdDeductionActive = (
      Number(profile.codeid) === 3 &&
      Number(profile.cdstatus) === 1 &&
      Number(profile.cdamount || 0) > Number(profile.cdtotal || 0)
    );
    const cdAmount = Number(profile.cdamount || 0);
    const cdTotal = Number(profile.cdtotal || 0);
    const cdRemaining = isCdDeductionActive ? cdAmount - cdTotal : 0;
    const breakdown = calculateEncashmentBreakdown({
      amount: encashmentAmount,
      cdRemaining,
      isCdDeductionActive,
    });

    const tax = breakdown.tax;
    const fee = breakdown.processingFee;
    const maintenanceFee = breakdown.maintenanceFee;
    const cdDeduction = breakdown.cdDeduction;
    const grossDeduction = breakdown.totalDeductions;
    const netEncashment = breakdown.net;
    const newBalance = currentBalance - encashmentAmount;

    if (netEncashment <= 0) {
      throw new Error('Invalid encashment amount');
    }

    const now = nowMySQL();

    const [balResult] = await conn.query(
      'UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = ? WHERE uid = ? LIMIT 1',
      [newBalance, now, uid]
    );
    if (balResult.affectedRows !== 1) {
      throw new Error('Unable to update wallet balance');
    }

    // Update CD tracking: increment cdtotal and clear cdstatus when fully paid.
    if (cdDeduction > 0) {
      const newCdTotal = Number(profile.cdtotal || 0) + cdDeduction;
      const cdAmount = Number(profile.cdamount || 0);
      const newCdStatus = newCdTotal >= cdAmount ? 2 : 1;
      await conn.query(
        'UPDATE usertab SET cdtotal = ?, cdstatus = ? WHERE uid = ? LIMIT 1',
        [newCdTotal, newCdStatus, uid]
      );
    }

    const payoutOptionInfo = resolvePayoutOption(profile.payoutid, { allowUnknown: true });
    const payoutId = Number(payoutOptionInfo?.id || 0);
    const payoutDetails = String(profile.payoutdetails || '').trim();
    const payoutOption = payoutOptionInfo?.label || 'Others';

    const [insertResult] = await conn.query(
      `INSERT INTO payouthistorytab
       (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
        income1, income2, income3, income4, income5, income6,
        income7, income8, income9, income10,
        encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
        cashstatus, paymentoptions, paymentdetails, cashtransdate, transdate,
        transactiontype, stockistid, processid)
       VALUES (NULL, ?, NULL, ?, ?, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0,
        ?, ?, 0, 0, ?, ?,
        0, ?, ?, ?, ?,
        10, 0, NULL)`,
      [
        uid,
        currentBalance,
        newBalance,
        netEncashment,
        tax,
        fee,
        cdDeduction,
        payoutOption || null,
        payoutDetails || null,
        now,
        now,
      ]
    );

    const encashmentUid = createPublicId();
    const requestId = options.requestId || 'server-request';
    const processKey = createProcessKey(['encashment', uid, requestId, encashmentAmount]);

    try {
      await conn.query(
        `INSERT INTO encashmentstab
         (encashment_uid, process_key, beneficiary_uid, payouthistory_pid,
          requested_amount, tax_amount, processing_fee, cd_deduction, maintenance_fee,
          net_payout, payout_option_id, payout_details_masked, status, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)
         ON DUPLICATE KEY UPDATE updated_at = updated_at`,
        [
          encashmentUid,
          processKey,
          uid,
          insertResult.insertId || null,
          encashmentAmount,
          tax,
          fee,
          cdDeduction,
          maintenanceFee,
          netEncashment,
          payoutId || null,
          maskSensitiveValue(payoutDetails),
          requestId,
        ]
      );

      await conn.query(
        `INSERT INTO income_eventstab
         (event_uid, process_key, beneficiary_uid, income_type, source_ref_uid, source_ref_type,
          gross_amount, tax_deduction, processing_fee, cd_deduction, maintenance_fee,
          net_amount, status, credited_at)
         VALUES (?, ?, ?, 'encashment_debit', ?, 'encashmentstab',
          ?, ?, ?, ?, ?, ?, 'credited', CURRENT_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE event_uid = event_uid`,
        [
          createPublicId(),
          createProcessKey(['income', 'encashment_debit', uid, processKey]),
          uid,
          encashmentUid,
          encashmentAmount,
          tax,
          fee,
          cdDeduction,
          maintenanceFee,
          netEncashment,
        ]
      );

      await writeAuditLog(conn, {
        req: options.req,
        requestId,
        actorUid: uid,
        actorRole: 'member',
        action: 'encashment.submit',
        targetUid: uid,
        targetTable: 'encashmentstab',
        targetId: encashmentUid,
        beforeState: { currentBalance },
        afterState: {
          requestedAmount: encashmentAmount,
          tax,
          processingFee: fee,
          maintenanceFee,
          cdDeduction,
          netPayout: netEncashment,
          newBalance,
        },
      });
    } catch (ledgerError) {
      if (ledgerError.code === 'ER_NO_SUCH_TABLE') {
        console.warn('[Encashment] ledger tables missing; run npm run db:migrate to enable mirrored ledgers.');
      } else {
        throw ledgerError;
      }
    }

    await conn.commit();

    const payoutDateObj = getNextPayoutDate(new Date());
    const payoutDate = payoutDateObj.toLocaleDateString('en-PH', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'Asia/Manila',
    });

    return {
      pid: Number(insertResult.insertId || 0),
      encashmentAmount,
      tax,
      fee,
      maintenanceFee,
      cdDeduction,
      grossDeduction,
      netEncashment,
      netReceivable: netEncashment,
      previousBalance: currentBalance,
      beginningBalance: currentBalance,
      newBalance,
      paymentOption: payoutOption,
      paymentOptionId: payoutId || null,
      paymentDetails: payoutDetails,
      paymentDetailsMasked: maskSensitiveValue(payoutDetails),
      processKey,
      payoutDate,
      payoutDateISO: payoutDateObj.toISOString().slice(0, 10),
    };
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }
    throw err;
  } finally {
    if (conn) {
      conn.release();
    }
  }
}

module.exports = { insertIncome, insertEncashment, getEncashmentPreview };
