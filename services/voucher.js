/**
 * Voucher System Service (DOC2 §4.1)
 *
 * Business Logic:
 * - One voucher per new member at registration based on package tier
 * - Voucher amount = package amount
 * - Buy 1 Take 1: cash paid = voucher deducted, member receives double products
 * - Expiry: Bronze=30d, Silver=40d, Gold=45d, Platinum=50d, Garnet=55d, Diamond=60d
 */
const { pool } = require('../config/database');

// Voucher expiry days by package type
const VOUCHER_EXPIRY_DAYS = {
  10: 30,   // Bronze
  20: 40,   // Silver
  30: 45,   // Gold
  40: 50,   // Platinum
  50: 55,   // Garnet
  60: 60,   // Diamond
};

// Package amounts
const PACKAGE_AMOUNTS = {
  10: 2500,
  20: 5000,
  30: 10000,
  40: 25000,
  50: 50000,
  60: 150000,
};

/**
 * Issue a voucher for a new member at registration
 * @param {object} conn - DB connection (for use within transaction)
 * @param {number} uid - Member UID
 * @param {number} packageType - Account type code (10-60)
 */
async function issueVoucher(conn, uid, packageType) {
  const amount = PACKAGE_AMOUNTS[packageType];
  const expiryDays = VOUCHER_EXPIRY_DAYS[packageType];

  if (!amount || !expiryDays) return null;

  const [result] = await conn.query(
    `INSERT INTO voucherstab (uid, package_type, voucher_amount, remaining_balance,
     issued_date, expiry_date, status)
     VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 1)`,
    [uid, packageType, amount, amount, expiryDays]
  );

  return result.insertId;
}

/**
 * Get all vouchers for a member
 */
async function getVouchers(uid) {
  const [rows] = await pool.query(
    `SELECT id, uid, package_type, voucher_amount, remaining_balance,
            DATE_FORMAT(issued_date, '%Y-%m-%d') as issued_date,
            DATE_FORMAT(expiry_date, '%Y-%m-%d') as expiry_date,
            status,
            CASE
              WHEN status = 3 THEN 'Fully Used'
              WHEN expiry_date < NOW() THEN 'Expired'
              ELSE 'Active'
            END as status_label
     FROM voucherstab WHERE uid = ? ORDER BY id DESC`,
    [uid]
  );

  // Auto-expire any vouchers past their expiry date
  for (const row of rows) {
    if (row.status === 1 && new Date(row.expiry_date) < new Date()) {
      await pool.query(
        'UPDATE voucherstab SET status = 2 WHERE id = ?',
        [row.id]
      );
      row.status = 2;
      row.status_label = 'Expired';
    }
  }

  return rows;
}

/**
 * Redeem a voucher (partial or full)
 * @param {number} uid - Member UID
 * @param {number} voucherId - Voucher ID
 * @param {number} cashAmount - Cash amount being paid by member
 * @returns {object} Redemption result
 */
async function redeemVoucher(uid, voucherId, cashAmount) {
  const [rows] = await pool.query(
    `SELECT * FROM voucherstab
     WHERE id = ? AND uid = ? AND status = 1 AND expiry_date >= NOW()`,
    [voucherId, uid]
  );

  if (rows.length === 0) {
    throw new Error('Voucher not found, expired, or already used');
  }

  const voucher = rows[0];
  const remaining = Number(voucher.remaining_balance);

  if (cashAmount <= 0) {
    throw new Error('Cash amount must be greater than 0');
  }

  // Buy 1 Take 1: deduct from voucher what the member pays in cash
  const voucherDeduction = Math.min(cashAmount, remaining);
  const newBalance = remaining - voucherDeduction;
  const newStatus = newBalance <= 0 ? 3 : 1; // 3 = fully used

  await pool.query(
    'UPDATE voucherstab SET remaining_balance = ?, status = ? WHERE id = ?',
    [newBalance, newStatus, voucherId]
  );

  return {
    voucherId,
    cashPaid: cashAmount,
    voucherDeducted: voucherDeduction,
    totalProductValue: cashAmount + voucherDeduction,
    remainingBalance: newBalance,
    fullyUsed: newStatus === 3,
  };
}

/**
 * Get all vouchers for admin view
 */
async function getAllVouchers(page = 1, perPage = 30) {
  const offset = (page - 1) * perPage;

  const [countRows] = await pool.query('SELECT COUNT(*) as total FROM voucherstab');
  const total = Number(countRows[0].total);

  const [rows] = await pool.query(
    `SELECT v.id, v.uid, v.package_type, v.voucher_amount, v.remaining_balance,
            DATE_FORMAT(v.issued_date, '%Y-%m-%d') as issued_date,
            DATE_FORMAT(v.expiry_date, '%Y-%m-%d') as expiry_date,
            v.status,
            m.firstname, m.lastname, m.username
     FROM voucherstab v
     LEFT JOIN memberstab m ON v.uid = m.uid
     ORDER BY v.id DESC
     LIMIT ?, ?`,
    [offset, perPage]
  );

  return {
    vouchers: rows,
    total,
    page,
    totalPages: Math.ceil(total / perPage),
  };
}

module.exports = {
  issueVoucher,
  getVouchers,
  redeemVoucher,
  getAllVouchers,
  VOUCHER_EXPIRY_DAYS,
  PACKAGE_AMOUNTS,
};
