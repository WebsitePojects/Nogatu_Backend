const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAccountTypeName } = require('../../utils/helpers');
const { PACKAGE_AMOUNTS, grantVouchersToExistingMembers } = require('../../services/voucher');

async function ensureVoucherTables() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS voucherstab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      package_type INT NOT NULL,
      voucher_amount DECIMAL(12,2) NOT NULL,
      remaining_balance DECIMAL(12,2) NOT NULL,
      issued_date DATETIME NOT NULL,
      expiry_date DATETIME NOT NULL,
      first_use_at DATETIME DEFAULT NULL,
      first_use_expires_at DATETIME DEFAULT NULL,
      first_use_status TINYINT NOT NULL DEFAULT 0,
      status INT DEFAULT 1,
      redeemed_date DATETIME DEFAULT NULL,
      suspend_reason VARCHAR(500) DEFAULT NULL,
      suspended_by VARCHAR(120) DEFAULT NULL,
      suspended_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_voucher_uid (uid),
      KEY idx_voucher_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

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
      KEY idx_vtx_uid (uid),
      KEY idx_vtx_voucher (voucher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function normalizeVoucherStatus(raw) {
  const value = String(raw || 'all').toLowerCase();
  return ['1', '2', '3', '4'].includes(value) ? Number(value) : 'all';
}

/**
 * GET /api/admin/voucher-management
 */
router.get('/', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;
    const search = String(req.query.search || '').trim();
    const status = normalizeVoucherStatus(req.query.status);

    const filters = [];
    const params = [];

    if (status !== 'all') {
      filters.push('v.status = ?');
      params.push(status);
    }

    if (search) {
      filters.push('(m.username LIKE ? OR CONCAT(v.id, \'\') LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM voucherstab v
       LEFT JOIN memberstab m ON m.uid = v.uid
       ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT v.id, v.uid, v.package_type, v.voucher_amount, v.remaining_balance, v.status,
              v.suspend_reason,
              DATE_FORMAT(v.issued_date, '%Y-%m-%d %H:%i') AS issued_at,
              DATE_FORMAT(v.expiry_date, '%Y-%m-%d %H:%i') AS expiry_at,
              m.username, m.firstname, m.lastname
       FROM voucherstab v
       LEFT JOIN memberstab m ON m.uid = v.uid
       ${whereSql}
       ORDER BY v.id DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    const [countsRows] = await pool.query(
      `SELECT COUNT(*) AS allCount,
              SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS activeCount,
              SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS expiredCount,
              SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS fullyUsedCount,
              SUM(CASE WHEN status = 4 THEN 1 ELSE 0 END) AS suspendedCount
       FROM voucherstab`
    );

    res.json({
      vouchers: rows.map((row) => ({
        id: Number(row.id),
        uid: Number(row.uid),
        username: row.username,
        fullName: `${row.firstname || ''} ${row.lastname || ''}`.trim() || null,
        package: getAccountTypeName(row.package_type),
        amount: Number(row.voucher_amount || 0),
        remaining: Number(row.remaining_balance || 0),
        status: Number(row.status || 0),
        issuedAt: row.issued_at,
        expiryAt: row.expiry_at,
        suspendReason: row.suspend_reason,
      })),
      counts: {
        all: Number(countsRows[0]?.allCount || 0),
        active: Number(countsRows[0]?.activeCount || 0),
        expired: Number(countsRows[0]?.expiredCount || 0),
        fullyUsed: Number(countsRows[0]?.fullyUsedCount || 0),
        suspended: Number(countsRows[0]?.suspendedCount || 0),
      },
      pagination: {
        page,
        perPage,
        total: Number(countRows[0]?.total || 0),
        totalPages: Math.max(1, Math.ceil(Number(countRows[0]?.total || 0) / perPage)),
      },
    });
  } catch (error) {
    console.error('[Admin Voucher Management] List error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/voucher-management/:id/transactions
 */
router.get('/:id/transactions', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const voucherId = Number(req.params.id);

    const [rows] = await pool.query(
      `SELECT id,
              DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') AS transaction_date,
              cash_paid, voucher_used, total_value
       FROM voucher_transactionstab
       WHERE voucher_id = ?
       ORDER BY transaction_date DESC, id DESC`,
      [voucherId]
    );

    res.json({
      transactions: rows.map((row) => ({
        id: Number(row.id),
        date: row.transaction_date,
        type: 'Voucher Redemption',
        amount: Number(row.voucher_used || row.total_value || 0),
        reference: `VTX-${row.id}`,
      })),
    });
  } catch (error) {
    console.error('[Admin Voucher Management] Transactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/voucher-management/:id/suspend
 */
router.put('/:id/suspend', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const voucherId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();

    if (!reason) {
      return res.status(400).json({ error: 'Suspension reason is required' });
    }

    const [result] = await pool.query(
      `UPDATE voucherstab
       SET status = 4, suspend_reason = ?, suspended_by = ?, suspended_at = NOW()
       WHERE id = ? AND status = 1
       LIMIT 1`,
      [reason, req.session.adminusername || String(req.session.adminid || 'admin'), voucherId]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Active voucher not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Admin Voucher Management] Suspend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/voucher-management/:id/unsuspend
 */
router.put('/:id/unsuspend', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const voucherId = Number(req.params.id);

    const [result] = await pool.query(
      `UPDATE voucherstab
       SET status = 1, suspend_reason = NULL, suspended_by = NULL, suspended_at = NULL
       WHERE id = ? AND status = 4
       LIMIT 1`,
      [voucherId]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Suspended voucher not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Admin Voucher Management] Unsuspend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/voucher-management/grant-existing
 */
router.post('/grant-existing', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const inserted = await grantVouchersToExistingMembers();

    res.json({
      success: true,
      inserted,
      message: `Granted ${inserted} voucher(s) to existing members without vouchers.`,
    });
  } catch (error) {
    console.error('[Admin Voucher Management] Grant existing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/voucher-management/grant-candidates
 */
router.get('/grant-candidates', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;
    const search = String(req.query.search || '').trim();

    const filters = ['u.uid = u.mainid'];
    const params = [];

    if (search) {
      filters.push('(m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ? OR CONCAT(u.uid, \'\') LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN voucherstab v ON v.uid = u.uid
       ${whereSql} AND v.id IS NULL`,
      params
    );

    const [rows] = await pool.query(
      `SELECT u.uid, u.currentaccttype, u.accttype,
              DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg,
              m.username, m.firstname, m.lastname
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN voucherstab v ON v.uid = u.uid
       ${whereSql} AND v.id IS NULL
       ORDER BY u.datereg DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    res.json({
      users: rows.map((row) => {
        const accttype = Number(row.currentaccttype || row.accttype || 0);
        return {
          uid: Number(row.uid),
          username: row.username,
          fullname: `${row.firstname} ${row.lastname}`.trim(),
          accttype,
          datereg: row.datereg,
          voucherAmount: Number(PACKAGE_AMOUNTS[accttype] || 0),
        };
      }),
      total: Number(countRows[0]?.total || 0),
      page,
      totalPages: Math.max(1, Math.ceil(Number(countRows[0]?.total || 0) / perPage)),
    });
  } catch (error) {
    console.error('[Admin Voucher Management] Grant candidates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/voucher-management/grant
 */
router.post('/grant', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await ensureVoucherTables();

    const uids = Array.isArray(req.body?.uids)
      ? req.body.uids.map((uid) => Number(uid)).filter((uid) => Number.isFinite(uid) && uid > 0)
      : [];

    if (uids.length === 0) {
      return res.status(400).json({ error: 'At least one UID is required' });
    }

    await connection.beginTransaction();

    let granted = 0;
    let skippedCount = 0;

    for (const uid of uids) {
      const [existing] = await connection.query(
        'SELECT id FROM voucherstab WHERE uid = ? LIMIT 1',
        [uid]
      );

      if (existing.length > 0) {
        skippedCount += 1;
        continue;
      }

      const [accountRows] = await connection.query(
        `SELECT currentaccttype, accttype
         FROM usertab
         WHERE uid = ? AND uid = mainid
         LIMIT 1`,
        [uid]
      );

      if (accountRows.length === 0) {
        skippedCount += 1;
        continue;
      }

      const accttype = Number(accountRows[0].currentaccttype || accountRows[0].accttype || 0);
      const voucherAmount = Number(PACKAGE_AMOUNTS[accttype] || 0);
      const expiryDays = {
        10: 30,
        20: 40,
        30: 45,
        40: 50,
        50: 55,
        60: 60,
      }[accttype];

      if (!voucherAmount || !expiryDays) {
        skippedCount += 1;
        continue;
      }

      await connection.query(
        `INSERT INTO voucherstab
           (uid, package_type, voucher_amount, remaining_balance, issued_date, expiry_date, status)
         VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 1)`,
        [uid, accttype, voucherAmount, voucherAmount, expiryDays]
      );

      granted += 1;
    }

    await connection.commit();
    res.json({ success: true, granted, skippedCount });
  } catch (error) {
    await connection.rollback();
    console.error('[Admin Voucher Management] Grant error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    connection.release();
  }
});

module.exports = router;
