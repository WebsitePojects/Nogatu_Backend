/**
 * Voucher System Service (DOC2 §4.1)
 *
 * Business Logic:
 * - One voucher per new member at registration based on package tier
 * - Voucher amount = package amount
 * - Buy 1 Take 1: cash paid = voucher deducted, member receives double products
 * - Unused voucher expiry: 224466 month ladder by package
 * - Used voucher expiry: first-use countdown keeps the existing day-based ladder
 */
const { pool } = require('../config/database');
const { VOUCHER_PRODUCT_CATALOG } = require('../constants/maintenanceProductCatalog');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('./schemaReadiness');

let voucherTableReady = false;
let voucherTxTableReady = false;

async function ensureVoucherTable() {
  if (voucherTableReady) return;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHERS, 'Vouchers');
  voucherTableReady = true;
}

async function ensureVoucherTxTable() {
  if (voucherTxTableReady) return;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHERS, 'Vouchers');
  voucherTxTableReady = true;
}

// Unused voucher expiry month ladder follows the approved 224466 rule.
const UNUSED_VOUCHER_EXPIRY_MONTHS = {
  10: 2,   // Bronze
  20: 2,   // Silver
  30: 4,   // Gold
  40: 4,   // Platinum
  50: 6,   // Garnet
  60: 6,   // Diamond
};

// Once a voucher is first used, keep the existing day-based countdown.
const USED_VOUCHER_EXPIRY_DAYS = {
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

const VOUCHER_PRODUCT_BY_CODE = Object.fromEntries(
  Object.values(VOUCHER_PRODUCT_CATALOG).map((product) => [product.code, product])
);

function normalizeVoucherProductSelection(options = {}) {
  const productKey = String(options.productKey || '').trim().toLowerCase();
  if (productKey && VOUCHER_PRODUCT_CATALOG[productKey]) {
    return VOUCHER_PRODUCT_CATALOG[productKey];
  }

  const productCode = Number(options.productCode || 0);
  if (productCode > 0 && VOUCHER_PRODUCT_BY_CODE[productCode]) {
    return VOUCHER_PRODUCT_BY_CODE[productCode];
  }

  return null;
}

/**
 * Business rule:
 * Voucher-funded product purchases must never earn repurchase points.
 */
function getVoucherRepurchasePoints() {
  return 0;
}

function buildVoucherExpiryLabel({ unusedExpiryDate, usedExpiryDate, firstUsedAt, status }) {
  if (Number(status || 0) === 2) return 'Expired';
  if (Number(status || 0) === 3) return 'Fully used';
  if (Number(status || 0) === 4) return 'Suspended';

  const targetDate = firstUsedAt ? usedExpiryDate : unusedExpiryDate;
  if (!targetDate) return firstUsedAt ? 'In use' : 'Active';

  const expiry = new Date(targetDate);
  if (Number.isNaN(expiry.getTime())) return 'Active';
  const diffMs = expiry.getTime() - Date.now();
  const daysRemaining = Math.max(0, Math.ceil(diffMs / 86400000));
  if (daysRemaining === 0) return 'Expires today';
  if (daysRemaining === 1) return '1 day left';
  return `${daysRemaining} days left`;
}

function getVoucherExpiryMode(row) {
  return row?.first_used_at ? 'used' : 'unused';
}

/**
 * Issue a voucher for a new member at registration
 * @param {object} conn - DB connection (for use within transaction)
 * @param {number} uid - Member UID
 * @param {number} packageType - Account type code (10-60)
 */
async function issueVoucher(conn, uid, packageType) {
  await ensureVoucherTable();

  const amount = PACKAGE_AMOUNTS[packageType];
  const expiryMonths = UNUSED_VOUCHER_EXPIRY_MONTHS[packageType];

  if (!amount || !expiryMonths) return null;

  const [result] = await conn.query(
    `INSERT INTO voucherstab (uid, package_type, voucher_amount, remaining_balance,
     issued_date, expiry_date, status)
     VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? MONTH), 1)`,
    [uid, packageType, amount, amount, expiryMonths]
  );

  return result.insertId;
}

/**
 * Get all vouchers for a member
 */
async function getVouchers(uid) {
  await ensureVoucherTable();

  await pool.query(
    `UPDATE voucherstab
        SET status = 2
      WHERE uid = ?
        AND status = 1
        AND (
          (first_used_at IS NULL AND expiry_date < NOW())
          OR
          (first_used_at IS NOT NULL AND use_expires_at IS NOT NULL AND use_expires_at < NOW())
        )`,
    [uid]
  );

  const [rows] = await pool.query(
    `SELECT id, uid, package_type, voucher_amount, remaining_balance,
            DATE_FORMAT(issued_date, '%Y-%m-%d') as issued_date,
            DATE_FORMAT(expiry_date, '%Y-%m-%d') as expiry_date,
            DATE_FORMAT(first_used_at, '%Y-%m-%d') as first_used_at,
            DATE_FORMAT(use_expires_at, '%Y-%m-%d') as use_expires_at,
            status,
            CASE
              WHEN status = 4 THEN 'Suspended'
              WHEN status = 3 THEN 'Fully Used'
              WHEN first_used_at IS NULL AND expiry_date < NOW() THEN 'Expired'
              WHEN first_used_at IS NOT NULL AND use_expires_at IS NOT NULL AND use_expires_at < NOW() THEN 'Expired'
              ELSE 'Active'
            END as status_label
     FROM voucherstab WHERE uid = ? ORDER BY id DESC`,
    [uid]
  );

  return rows.map((row) => ({
    ...row,
    expiry_mode: getVoucherExpiryMode(row),
    expiry_label: buildVoucherExpiryLabel({
      unusedExpiryDate: row.expiry_date,
      usedExpiryDate: row.use_expires_at,
      firstUsedAt: row.first_used_at,
      status: row.status,
    }),
  }));
}

/**
 * Redeem a voucher (partial or full) with wallet deduction.
 * @param {number} uid - Member UID
 * @param {?number} voucherId - Optional voucher ID (auto-picks active voucher when omitted)
 * @param {number} cashAmount - Cash amount being paid by member
 * @param {object} options - Optional metadata
 * @returns {object} Redemption result
 */
async function redeemVoucher(uid, voucherId, cashAmount, options = {}) {
  await ensureVoucherTable();
  await ensureVoucherTxTable();

  const memberUid = Number(uid);
  if (!Number.isFinite(memberUid) || memberUid <= 0) {
    throw new Error('Invalid member ID');
  }

  if (!Number.isFinite(Number(cashAmount)) || Number(cashAmount) <= 0) {
    throw new Error('Cash amount must be greater than 0');
  }

  const selectedVoucherId = Number(voucherId || 0);
  const cashPaid = Number(cashAmount);
  const selectedProduct = normalizeVoucherProductSelection(options);
  const lockKey = `nogatu_income_calc_${memberUid}`;

  const conn = await pool.getConnection();
  let lockAcquired = false;
  let txStarted = false;
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) {
      throw new Error('Unable to process checkout right now. Please retry.');
    }

    await conn.beginTransaction();
    txStarted = true;

    let rows = [];
    if (selectedVoucherId > 0) {
      const [voucherRows] = await conn.query(
        `SELECT * FROM voucherstab
         WHERE id = ? AND uid = ? AND status = 1
           AND remaining_balance > 0
           AND (
             (first_used_at IS NULL AND expiry_date >= NOW())
             OR
             (first_used_at IS NOT NULL AND use_expires_at IS NOT NULL AND use_expires_at >= NOW())
           )
         LIMIT 1
         FOR UPDATE`,
        [selectedVoucherId, memberUid]
      );
      rows = voucherRows;
    } else {
      const [voucherRows] = await conn.query(
        `SELECT * FROM voucherstab
         WHERE uid = ? AND status = 1
           AND remaining_balance > 0
           AND (
             (first_used_at IS NULL AND expiry_date >= NOW())
             OR
             (first_used_at IS NOT NULL AND use_expires_at IS NOT NULL AND use_expires_at >= NOW())
           )
         ORDER BY COALESCE(use_expires_at, expiry_date) ASC, id ASC
         LIMIT 1
         FOR UPDATE`,
        [memberUid]
      );
      rows = voucherRows;
    }

    if (rows.length === 0) {
      throw new Error('No active voucher is available for checkout');
    }

    const voucher = rows[0];
    const resolvedVoucherId = Number(voucher.id || 0);
    const remaining = Number(voucher.remaining_balance || 0);
    if (remaining <= 0) {
      throw new Error('Selected voucher has no remaining balance');
    }

    const [walletRows] = await conn.query(
      'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE',
      [memberUid]
    );

    const currentWalletBalance = Number(walletRows[0]?.ttlcashbalance || 0);
    if (cashPaid > currentWalletBalance) {
      throw new Error('Insufficient wallet balance for this checkout');
    }

    // Buy 1 Take 1: voucher deduction matches cash paid, capped by remaining voucher balance.
    const voucherDeduction = Math.min(cashPaid, remaining);
    if (voucherDeduction <= 0) {
      throw new Error('Voucher deduction must be greater than 0');
    }

    const newBalance = remaining - voucherDeduction;
    const newStatus = newBalance <= 0 ? 3 : 1;
    const newWalletBalance = currentWalletBalance - cashPaid;
    const firstUseDays = Number(USED_VOUCHER_EXPIRY_DAYS[Number(voucher.package_type || 0)] || 0);
    const startsFirstUseWindow = !voucher.first_used_at && voucherDeduction > 0 && firstUseDays > 0;

    await conn.query(
      `UPDATE voucherstab
          SET remaining_balance = ?,
              status = ?,
              first_used_at = CASE WHEN ? THEN NOW() ELSE first_used_at END,
              use_expires_at = CASE
                WHEN ? THEN DATE_ADD(NOW(), INTERVAL ? DAY)
                ELSE use_expires_at
              END,
              redeemed_date = CASE WHEN ? = 3 THEN NOW() ELSE redeemed_date END
        WHERE id = ? LIMIT 1`,
      [newBalance, newStatus, startsFirstUseWindow ? 1 : 0, startsFirstUseWindow ? 1 : 0, firstUseDays, newStatus, resolvedVoucherId]
    );

    const [walletUpdate] = await conn.query(
      'UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = NOW() WHERE uid = ? LIMIT 1',
      [newWalletBalance, memberUid]
    );
    if (Number(walletUpdate.affectedRows || 0) !== 1) {
      throw new Error('Unable to update wallet balance');
    }

    // Log the transaction
    await conn.query(
      `INSERT INTO voucher_transactionstab (uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [memberUid, resolvedVoucherId, cashPaid, voucherDeduction, cashPaid + voucherDeduction]
    );

    if (selectedProduct) {
      const voucherReferenceCode = `VCHR-${resolvedVoucherId}-${Date.now()}`;
      const repurchasePoints = getVoucherRepurchasePoints();
      await conn.query(
        `INSERT INTO repurchasetab (id, uid, producttype, code, transtype, codeid, incentivepoints1, transdate)
         VALUES (NULL, ?, ?, ?, 1, 1, ?, NOW())`,
        [memberUid, selectedProduct.code, voucherReferenceCode, repurchasePoints]
      );
    }

    await conn.commit();
    txStarted = false;

    const safeProductName = String(options?.productName || '').trim();
    return {
      voucherId: resolvedVoucherId,
      cashPaid,
      voucherDeducted: voucherDeduction,
      totalProductValue: cashPaid + voucherDeduction,
      remainingBalance: newBalance,
      walletBalance: newWalletBalance,
      fullyUsed: newStatus === 3,
      productType: selectedProduct?.code || null,
      ...(safeProductName ? { productName: safeProductName } : {}),
    };
  } catch (err) {
    if (txStarted) {
      await conn.rollback();
    }
    throw err;
  } finally {
    if (lockAcquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]);
      } catch {
        // Ignore lock release failures.
      }
    }
    conn.release();
  }
}

/**
 * Get voucher transaction history for a member
 */
async function getVoucherTransactions(uid) {
  await ensureVoucherTxTable();

  const [rows] = await pool.query(
    `SELECT id, uid, voucher_id, cash_paid, voucher_used, total_value,
            DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') as transaction_date
     FROM voucher_transactionstab
     WHERE uid = ?
     ORDER BY id DESC
     LIMIT 100`,
    [uid]
  );

  return rows;
}

/**
 * Get all vouchers for admin view
 */
async function getAllVouchers(page = 1, perPage = 30) {
  await ensureVoucherTable();

  await pool.query(
    `UPDATE voucherstab
        SET status = 2
      WHERE status = 1
        AND (
          (first_used_at IS NULL AND expiry_date < NOW())
          OR
          (first_used_at IS NOT NULL AND use_expires_at IS NOT NULL AND use_expires_at < NOW())
        )`
  );

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

/**
 * Get members eligible for manual voucher grant.
 * Eligibility: main account, valid package tier, and no voucher record at all.
 */
async function getGrantEligibleMembers(page = 1, perPage = 30, search = '') {
  await ensureVoucherTable();

  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.max(1, Math.min(100, Number(perPage) || 30));
  const offset = (safePage - 1) * safePerPage;

  const where = [
    'u.uid = u.mainid',
    'u.currentaccttype IN (10,20,30,40,50,60)',
    'v.uid IS NULL',
  ];
  const params = [];

  const keyword = String(search || '').trim();
  if (keyword) {
    const like = `%${keyword}%`;
    where.push('(m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ? OR CAST(m.uid AS CHAR) LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM usertab u
     JOIN memberstab m ON m.uid = u.uid
     LEFT JOIN voucherstab v ON v.uid = u.uid
     ${whereSql}`,
    params
  );

  const total = Number(countRows[0]?.total || 0);

  const [rows] = await pool.query(
    `SELECT
       m.uid,
       m.username,
       m.firstname,
       m.lastname,
       u.currentaccttype,
       DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg
     FROM usertab u
     JOIN memberstab m ON m.uid = u.uid
     LEFT JOIN voucherstab v ON v.uid = u.uid
     ${whereSql}
     ORDER BY u.datereg DESC
     LIMIT ?, ?`,
    [...params, offset, safePerPage]
  );

  const users = rows.map((row) => {
    const accttype = Number(row.currentaccttype || 0);
    return {
      uid: Number(row.uid),
      username: row.username,
      firstname: row.firstname,
      lastname: row.lastname,
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
      accttype,
      voucherAmount: Number(PACKAGE_AMOUNTS[accttype] || 0),
      datereg: row.datereg,
    };
  });

  return {
    users,
    page: safePage,
    perPage: safePerPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePerPage)),
  };
}

/**
 * Grant vouchers to selected members.
 * Members with existing voucher history are skipped.
 */
async function grantVouchersToMembers(uids = []) {
  await ensureVoucherTable();

  const cleanUids = Array.from(new Set(
    (Array.isArray(uids) ? uids : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  if (cleanUids.length === 0) {
    return {
      requested: 0,
      granted: 0,
      skippedCount: 0,
      skippedUids: [],
      grantedUids: [],
    };
  }

  const placeholders = cleanUids.map(() => '?').join(',');
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [eligibleRows] = await conn.query(
      `SELECT u.uid, u.currentaccttype
       FROM usertab u
       LEFT JOIN voucherstab v ON v.uid = u.uid
       WHERE u.uid IN (${placeholders})
         AND u.uid = u.mainid
         AND u.currentaccttype IN (10,20,30,40,50,60)
         AND v.uid IS NULL
       FOR UPDATE`,
      cleanUids
    );

    const grantedUids = [];
    for (const row of eligibleRows) {
      const uid = Number(row.uid);
      const packageType = Number(row.currentaccttype || 0);
      const amount = Number(PACKAGE_AMOUNTS[packageType] || 0);
      const expiryMonths = Number(UNUSED_VOUCHER_EXPIRY_MONTHS[packageType] || 0);

      if (!uid || !amount || !expiryMonths) continue;

      await conn.query(
        `INSERT INTO voucherstab
          (uid, package_type, voucher_amount, remaining_balance, issued_date, expiry_date, status)
         VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? MONTH), 1)`,
        [uid, packageType, amount, amount, expiryMonths]
      );

      grantedUids.push(uid);
    }

    await conn.commit();

    const skippedUids = cleanUids.filter((uid) => !grantedUids.includes(uid));

    return {
      requested: cleanUids.length,
      granted: grantedUids.length,
      skippedCount: skippedUids.length,
      skippedUids,
      grantedUids,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Grant one-time vouchers to existing members that still have no voucher record.
 * Idempotent: reruns only insert for members without any voucher row.
 */
async function grantVouchersToExistingMembers() {
  await ensureVoucherTable();

  const [result] = await pool.query(
    `INSERT INTO voucherstab
      (uid, package_type, voucher_amount, remaining_balance, issued_date, expiry_date, status)
     SELECT
       u.uid,
       u.currentaccttype,
       CASE u.currentaccttype
         WHEN 10 THEN 2500
         WHEN 20 THEN 5000
         WHEN 30 THEN 10000
         WHEN 40 THEN 25000
         WHEN 50 THEN 50000
         WHEN 60 THEN 150000
       END AS voucher_amount,
       CASE u.currentaccttype
         WHEN 10 THEN 2500
         WHEN 20 THEN 5000
         WHEN 30 THEN 10000
         WHEN 40 THEN 25000
         WHEN 50 THEN 50000
         WHEN 60 THEN 150000
       END AS remaining_balance,
       NOW(),
       DATE_ADD(
         NOW(),
         INTERVAL CASE u.currentaccttype
           WHEN 10 THEN 2
           WHEN 20 THEN 2
           WHEN 30 THEN 4
           WHEN 40 THEN 4
           WHEN 50 THEN 6
           WHEN 60 THEN 6
         END MONTH
       ),
       1
     FROM usertab u
     LEFT JOIN voucherstab v ON v.uid = u.uid
     WHERE u.uid = u.mainid
       AND u.currentaccttype IN (10, 20, 30, 40, 50, 60)
       AND v.uid IS NULL`
  );

  return Number(result.affectedRows || 0);
}

module.exports = {
  issueVoucher,
  getVouchers,
  redeemVoucher,
  getVoucherTransactions,
  getAllVouchers,
  getGrantEligibleMembers,
  grantVouchersToMembers,
  grantVouchersToExistingMembers,
  ensureVoucherTable,
  ensureVoucherTxTable,
  normalizeVoucherProductSelection,
  VOUCHER_PRODUCT_CATALOG,
  UNUSED_VOUCHER_EXPIRY_MONTHS,
  USED_VOUCHER_EXPIRY_DAYS,
  PACKAGE_AMOUNTS,
  buildVoucherExpiryLabel,
  getVoucherExpiryMode,
  getVoucherRepurchasePoints,
};
