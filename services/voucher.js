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

let voucherTableReady = false;
let voucherTxTableReady = false;

async function ensureVoucherTable() {
  if (voucherTableReady) return;

  await pool.query(
    `CREATE TABLE IF NOT EXISTS voucherstab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      package_type INT NOT NULL,
      voucher_amount DECIMAL(12,2) NOT NULL,
      remaining_balance DECIMAL(12,2) NOT NULL,
      issued_date DATETIME NOT NULL,
      expiry_date DATETIME NOT NULL,
      status INT NOT NULL DEFAULT 1,
      redeemed_date DATETIME DEFAULT NULL,
      suspend_reason VARCHAR(500) DEFAULT NULL,
      suspended_by VARCHAR(120) DEFAULT NULL,
      suspended_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_uid (uid),
      KEY idx_status (status),
      KEY idx_expiry_date (expiry_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // Add suspend columns if table existed before this update
  try {
    await pool.query('ALTER TABLE voucherstab ADD COLUMN suspend_reason VARCHAR(500) DEFAULT NULL');
  } catch { /* column exists */ }
  try {
    await pool.query('ALTER TABLE voucherstab ADD COLUMN suspended_by VARCHAR(120) DEFAULT NULL');
  } catch { /* column exists */ }
  try {
    await pool.query('ALTER TABLE voucherstab ADD COLUMN suspended_at DATETIME DEFAULT NULL');
  } catch { /* column exists */ }

  voucherTableReady = true;
}

async function ensureVoucherTxTable() {
  if (voucherTxTableReady) return;

  await pool.query(
    `CREATE TABLE IF NOT EXISTS voucher_transactionstab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      voucher_id INT NOT NULL,
      cash_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
      voucher_used DECIMAL(12,2) NOT NULL DEFAULT 0,
      total_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_uid (uid),
      KEY idx_voucher_id (voucher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  voucherTxTableReady = true;
}

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

const VOUCHER_PRODUCT_CATALOG = {
  bl: { code: 100, name: 'Barley Juice', incentivePoints: 50 },
  gl: { code: 101, name: 'Nogatu Glow', incentivePoints: 45 },
  glc: { code: 102, name: 'Collagen Vitamin C', incentivePoints: 40 },
  cm: { code: 103, name: 'Coffee Mix', incentivePoints: 40 },
  cd: { code: 104, name: 'Chocolate Drink Mix', incentivePoints: 45 },
  mgt: { code: 105, name: 'Mangosteen Coffee', incentivePoints: 30 },
  vz: { code: 106, name: 'Vitamin Zinc', incentivePoints: 40 },
  cmm: { code: 107, name: 'MAX Coffee Mix', incentivePoints: 100 },
  bkc: { code: 108, name: 'Black Coffee', incentivePoints: 10 },
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
 * Issue a voucher for a new member at registration
 * @param {object} conn - DB connection (for use within transaction)
 * @param {number} uid - Member UID
 * @param {number} packageType - Account type code (10-60)
 */
async function issueVoucher(conn, uid, packageType) {
  await ensureVoucherTable();

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
  await ensureVoucherTable();

  await pool.query(
    'UPDATE voucherstab SET status = 2 WHERE uid = ? AND status = 1 AND expiry_date < NOW()',
    [uid]
  );

  const [rows] = await pool.query(
    `SELECT id, uid, package_type, voucher_amount, remaining_balance,
            DATE_FORMAT(issued_date, '%Y-%m-%d') as issued_date,
            DATE_FORMAT(expiry_date, '%Y-%m-%d') as expiry_date,
            status,
            CASE
              WHEN status = 4 THEN 'Suspended'
              WHEN status = 3 THEN 'Fully Used'
              WHEN expiry_date < NOW() THEN 'Expired'
              ELSE 'Active'
            END as status_label
     FROM voucherstab WHERE uid = ? ORDER BY id DESC`,
    [uid]
  );

  return rows;
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
         WHERE id = ? AND uid = ? AND status = 1 AND expiry_date >= NOW() AND remaining_balance > 0
         LIMIT 1
         FOR UPDATE`,
        [selectedVoucherId, memberUid]
      );
      rows = voucherRows;
    } else {
      const [voucherRows] = await conn.query(
        `SELECT * FROM voucherstab
         WHERE uid = ? AND status = 1 AND expiry_date >= NOW() AND remaining_balance > 0
         ORDER BY expiry_date ASC, id ASC
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

    await conn.query(
      `UPDATE voucherstab
          SET remaining_balance = ?,
              status = ?,
              redeemed_date = CASE WHEN ? = 3 THEN NOW() ELSE redeemed_date END
        WHERE id = ? LIMIT 1`,
      [newBalance, newStatus, newStatus, resolvedVoucherId]
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
      await conn.query(
        `INSERT INTO repurchasetab (id, uid, producttype, code, transtype, codeid, incentivepoints1, transdate)
         VALUES (NULL, ?, ?, ?, 1, 1, ?, NOW())`,
        [memberUid, selectedProduct.code, voucherReferenceCode, selectedProduct.incentivePoints]
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

  await pool.query('UPDATE voucherstab SET status = 2 WHERE status = 1 AND expiry_date < NOW()');

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
      const expiryDays = Number(VOUCHER_EXPIRY_DAYS[packageType] || 0);

      if (!uid || !amount || !expiryDays) continue;

      await conn.query(
        `INSERT INTO voucherstab
          (uid, package_type, voucher_amount, remaining_balance, issued_date, expiry_date, status)
         VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 1)`,
        [uid, packageType, amount, amount, expiryDays]
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
           WHEN 10 THEN 30
           WHEN 20 THEN 40
           WHEN 30 THEN 45
           WHEN 40 THEN 50
           WHEN 50 THEN 55
           WHEN 60 THEN 60
         END DAY
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
  VOUCHER_EXPIRY_DAYS,
  PACKAGE_AMOUNTS,
};
