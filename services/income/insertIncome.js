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

const PAYOUT_OPTION_LABELS = {
  1: 'Pickup',
  2: 'GCash',
  3: 'Remittance Center',
  4: 'Bank Deposit',
  5: 'Others',
};

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
 *   { dref, paircash, leadership, unilevel, hifive, lpc, beginningbalance, endingbalance }
 */
async function insertIncome(uid, income) {
  const {
    dref = 0,
    paircash = 0,
    leadership = 0,
    unilevel = 0,
    hifive = 0,
    ppctemp = 0,
    lpc = 0,
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
     dref, paircash, leadership, unilevel, hifive, lpc, now]
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
    [uid, dref, paircash, leadership, unilevel, hifive, ppctemp, lpc, endingbalance, pairproduct, now]
  );

  return true;
}

/**
 * Process encashment (cash withdrawal)
 * @param {number} uid - User ID
 * @param {number} encashmentAmount - Amount to withdraw
 * @param {Object} userInfo - { codeid, cdstatus, cdamount, cdtotal }
 * @returns {Object} Encashment result details
 */
async function insertEncashment(uid, encashmentAmount, userInfo) {
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

    // Calculate deductions
    const tax = encashmentAmount * 0.10; // 10% tax
    const fee = 50; // Fixed processing fee

    // CD deduction (25% if codeid == 3 and CD debt is still active).
    let cdDeduction = 0;
    if (
      Number(profile.codeid) === 3 &&
      Number(profile.cdstatus) === 1 &&
      Number(profile.cdamount || 0) > Number(profile.cdtotal || 0)
    ) {
      const cdAmount = Number(profile.cdamount || 0);
      const cdTotal = Number(profile.cdtotal || 0);
      const cdRemaining = cdAmount - cdTotal;
      cdDeduction = Math.min(encashmentAmount * 0.25, Math.max(0, cdRemaining));
    }

    const grossDeduction = tax + fee + cdDeduction;
    const netEncashment = encashmentAmount - grossDeduction;
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

    const payoutId = Number(profile.payoutid || 0);
    const payoutDetails = String(profile.payoutdetails || '').trim();
    const payoutOption = PAYOUT_OPTION_LABELS[payoutId] || 'Others';

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
        payoutId || null,
        payoutDetails || null,
        now,
        now,
      ]
    );

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

module.exports = { insertIncome, insertEncashment };
