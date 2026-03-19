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
    lpc = 0,
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
     (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6,
      ttlcashbalance, ttlpointsbalance, transdate)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE
      ttlincome1 = ttlincome1 + VALUES(ttlincome1),
      ttlincome2 = ttlincome2 + VALUES(ttlincome2),
      ttlincome3 = ttlincome3 + VALUES(ttlincome3),
      ttlincome4 = ttlincome4 + VALUES(ttlincome4),
      ttlincome5 = ttlincome5 + VALUES(ttlincome5),
      ttlincome6 = ttlincome6 + VALUES(ttlincome6),
      ttlcashbalance = ttlcashbalance + VALUES(ttlcashbalance),
      transdate = VALUES(transdate)`,
    [uid, dref, paircash, leadership, unilevel, hifive, lpc, endingbalance - beginningbalance, now]
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
  // Get current balance
  const [balanceRows] = await pool.query(
    'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ?',
    [uid]
  );

  const currentBalance = Number(balanceRows[0]?.ttlcashbalance || 0);

  if (encashmentAmount > currentBalance || encashmentAmount < 500) {
    throw new Error('Invalid encashment amount');
  }

  // Calculate deductions
  const tax = encashmentAmount * 0.10; // 10% tax
  const fee = 50; // Fixed processing fee

  // CD deduction (25% if codeid == 3 and cdstatus == 1, capped against remaining CD debt)
  let cdDeduction = 0;
  if (Number(userInfo.codeid) === 3 && Number(userInfo.cdstatus) === 1) {
    const cdAmount = Number(userInfo.cdamount || 0);
    const cdTotal = Number(userInfo.cdtotal || 0);
    const cdRemaining = cdAmount - cdTotal; // Remaining CD debt
    cdDeduction = Math.min(encashmentAmount * 0.25, Math.max(0, cdRemaining));
  }

  const grossDeduction = tax + fee + cdDeduction;
  const netEncashment = encashmentAmount - grossDeduction;
  const newBalance = currentBalance - encashmentAmount;

  const now = nowMySQL();

  // Update payouttotaltab balance
  await pool.query(
    'UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = ? WHERE uid = ?',
    [newBalance, now, uid]
  );

  // Update CD tracking: increment cdtotal and clear cdstatus when fully paid
  if (cdDeduction > 0) {
    const newCdTotal = Number(userInfo.cdtotal || 0) + cdDeduction;
    const cdAmount = Number(userInfo.cdamount || 0);
    const newCdStatus = newCdTotal >= cdAmount ? 2 : 1; // 2 = fully paid
    await pool.query(
      'UPDATE usertab SET cdtotal = ?, cdstatus = ? WHERE uid = ?',
      [newCdTotal, newCdStatus, uid]
    );
  }

  // Insert encashment record into payouthistorytab
  await pool.query(
    `INSERT INTO payouthistorytab
     (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
      income1, income2, income3, income4, income5, income6,
      income7, income8, income9, income10,
      encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
      cashstatus, cashtransdate, transdate, transactiontype, stockistid, processid)
     VALUES (NULL, ?, NULL, ?, ?, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
      ?, ?, 0, 0, ?, ?,
      0, ?, ?, 10, 0, NULL)`,
    [uid, currentBalance, newBalance,
     encashmentAmount, tax, fee, cdDeduction,
     now, now]
  );

  return {
    encashmentAmount,
    tax,
    fee,
    cdDeduction,
    grossDeduction,
    netEncashment,
    previousBalance: currentBalance,
    newBalance,
  };
}

module.exports = { insertIncome, insertEncashment };
