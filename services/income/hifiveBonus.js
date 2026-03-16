/**
 * Hi-Five Bonus Calculation
 * 1:1 port of PHP income-h5bonus-fnc.php
 *
 * Income Type 5 (income5)
 * - Product-specific tracking in h5bonustab
 * - 9 product categories (prod0-prod8)
 * - Redeemable via insert_Redeem()
 */
const { pool } = require('../../config/database');
const { currentMonthRange } = require('../../utils/helpers');

// Product key to column mapping
const PRODUCT_COLS = {
  bl: 'prod0',   // 100 Barley
  gl: 'prod1',   // 101 Glutathione
  glc: 'prod2',  // 102 Gluta w/ Collagen
  cm: 'prod3',   // 103 Coffee Mix
  cd: 'prod4',   // 104 Chocolate Drink
  mgt: 'prod5',  // 105 Mangosteen
  vz: 'prod6',   // 106 Vitamin Zinc
  cmm: 'prod7',  // 107 Max Coffee
  bkc: 'prod8',  // 108 Black Coffee
};

const PRODUCT_TYPE_TO_KEY = {
  100: 'bl',
  101: 'gl',
  102: 'glc',
  103: 'cm',
  104: 'cd',
  105: 'mgt',
  106: 'vz',
  107: 'cmm',
  108: 'bkc',
};

/**
 * Check Hi-Five bonus balances for a user
 * Mirrors PHP chkH5bonus()
 */
async function checkH5Bonus(uid) {
  const [rows] = await pool.query(
    'SELECT * FROM h5bonustab WHERE uid = ?',
    [uid]
  );

  if (rows.length === 0) {
    return { bl: 0, gl: 0, glc: 0, cm: 0, cd: 0, mgt: 0, vz: 0, cmm: 0, bkc: 0 };
  }

  const row = rows[0];
  return {
    bl: Number(row.prod0 || 0),
    gl: Number(row.prod1 || 0),
    glc: Number(row.prod2 || 0),
    cm: Number(row.prod3 || 0),
    cd: Number(row.prod4 || 0),
    mgt: Number(row.prod5 || 0),
    vz: Number(row.prod6 || 0),
    cmm: Number(row.prod7 || 0),
    bkc: Number(row.prod8 || 0),
  };
}

/**
 * Get direct referral purchase counts for current month
 * Mirrors PHP get_drefpurchase()
 */
async function getDrefPurchase(uid) {
  const { start, end } = currentMonthRange();

  const [rows] = await pool.query(
    `SELECT producttype, COUNT(*) as cnt
     FROM repurchasetab
     WHERE uid = ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
       AND producttype >= 100
     GROUP BY producttype`,
    [uid, start, end]
  );

  const purchases = {};
  for (const row of rows) {
    const key = PRODUCT_TYPE_TO_KEY[row.producttype];
    if (key) purchases[key] = Number(row.cnt);
  }

  return purchases;
}

/**
 * Redeem Hi-Five bonus for a product
 * Mirrors PHP insert_Redeem()
 */
async function insertRedeem(uid, bonusType, totalBonus) {
  const col = PRODUCT_COLS[bonusType];
  if (!col) throw new Error('Invalid bonus type');

  // Update h5bonustab
  await pool.query(
    `UPDATE h5bonustab SET ${col} = ${col} + ?, lasttransupdate = CURDATE()
     WHERE uid = ?`,
    [totalBonus, uid]
  );

  // Insert record into h5historytab
  const productTypeMap = Object.entries(PRODUCT_TYPE_TO_KEY).find(([, v]) => v === bonusType);
  const productType = productTypeMap ? Number(productTypeMap[0]) : 0;

  await pool.query(
    `INSERT INTO h5historytab (pid, uid, producttype, ttlbonus, redeemstatus, redeemdate, transactiontype)
     VALUES (NULL, ?, ?, ?, 0, NOW(), 1)`,
    [uid, productType, totalBonus]
  );

  return true;
}

module.exports = { checkH5Bonus, getDrefPurchase, insertRedeem, PRODUCT_TYPE_TO_KEY };
