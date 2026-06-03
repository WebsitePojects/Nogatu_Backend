/**
 * Admin Voucher Management Routes
 * Handles voucher listing, suspension, reactivation, and transaction history.
 * Accessible by all admin roles: admin (1), cashier (2), BOD (3).
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  ensureVoucherTable,
  ensureVoucherTxTable,
  grantVouchersToExistingMembers,
  getGrantEligibleMembers,
  grantVouchersToMembers,
} = require('../../services/voucher');

const PER_PAGE = 30;

const STATUS_MAP = {
  1: 'Active',
  2: 'Expired',
  3: 'Fully Used',
  4: 'Suspended',
};

const PACKAGE_MAP = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

const STATUS_CODE_BY_FILTER = {
  active: 1,
  expired: 2,
  used: 3,
  suspended: 4,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
};

/**
 * GET /api/admin/voucher-management?page=1&search=keyword&status=all|active|expired|used|suspended
 * List all vouchers with pagination, filtering, and summary counts
 */
router.get('/', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTable();

    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * PER_PAGE;
    const search = (req.query.search || '').trim();
    const statusFilter = (req.query.status || 'all').toLowerCase();

    // Build WHERE clauses
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (statusFilter !== 'all') {
      const statusCode = STATUS_CODE_BY_FILTER[statusFilter];
      if (statusCode) {
        conditions.push('v.status = ?');
        params.push(statusCode);
      }
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // Summary counts (unfiltered by status/search — gives overall totals)
    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(*) AS total,
        SUM(v.status = 1) AS active,
        SUM(v.status = 2) AS expired,
        SUM(v.status = 3) AS used,
        SUM(v.status = 4) AS suspended
      FROM voucherstab v`
    );
    const summary = {
      total: Number(summaryRows[0].total) || 0,
      active: Number(summaryRows[0].active) || 0,
      expired: Number(summaryRows[0].expired) || 0,
      used: Number(summaryRows[0].used) || 0,
      suspended: Number(summaryRows[0].suspended) || 0,
    };

    // Count query (with filters applied)
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM voucherstab v
       LEFT JOIN memberstab m ON v.uid = m.uid
       ${whereClause}`,
      params
    );
    const totalFiltered = Number(countRows[0].total) || 0;
    const totalPages = Math.ceil(totalFiltered / PER_PAGE) || 1;

    // List query
    const [vouchers] = await pool.query(
      `SELECT v.id, v.uid, v.package_type, v.voucher_amount, v.remaining_balance,
              v.issued_date, v.expiry_date, v.status, v.redeemed_date,
              v.suspend_reason, v.suspended_by, v.suspended_at,
              m.username, m.firstname, m.lastname
       FROM voucherstab v
       LEFT JOIN memberstab m ON v.uid = m.uid
       ${whereClause}
       ORDER BY v.id DESC
       LIMIT ? OFFSET ?`,
      [...params, PER_PAGE, offset]
    );

    const formatted = vouchers.map((v) => {
      const fullName = `${v.firstname || ''} ${v.lastname || ''}`.trim();
      const packageName = PACKAGE_MAP[v.package_type] || `Type ${v.package_type}`;

      return {
        ...v,
        status_label: STATUS_MAP[v.status] || 'Unknown',
        package_name: packageName,

        // Compatibility fields consumed by current frontend page.
        fullName,
        package: packageName,
        amount: Number(v.voucher_amount || 0),
        remaining: Number(v.remaining_balance || 0),
        issuedAt: v.issued_date,
        expiryAt: v.expiry_date,
        suspendReason: v.suspend_reason,
      };
    });

    const counts = {
      all: summary.total,
      active: summary.active,
      expired: summary.expired,
      fullyUsed: summary.used,
      suspended: summary.suspended,
    };

    res.json({
      vouchers: formatted,
      pagination: {
        page,
        perPage: PER_PAGE,
        totalFiltered,
        totalPages,
      },
      counts,
      summary,
    });
  } catch (err) {
    console.error('[Voucher Mgmt] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/voucher-management/grant-existing
 * Grant one-time vouchers to existing members that have no voucher yet.
 */
router.post('/grant-existing', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    const inserted = await grantVouchersToExistingMembers();
    res.json({
      success: true,
      inserted,
      message: `Granted ${inserted} voucher(s) to existing members without vouchers.`,
    });
  } catch (err) {
    console.error('[Voucher Mgmt] Grant existing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/voucher-management/grant-candidates?page=1&search=keyword
 * List members who have no voucher history and can be granted manually.
 */
router.get('/grant-candidates', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.max(1, Math.min(100, Number(req.query.perPage) || 30));
    const search = (req.query.search || '').trim();

    const result = await getGrantEligibleMembers(page, perPage, search);
    res.json(result);
  } catch (err) {
    console.error('[Voucher Mgmt] Grant candidates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/voucher-management/grant
 * Body: { uids: number[] }
 * Grant vouchers to selected eligible members.
 */
router.post('/grant', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    const rawUids = Array.isArray(req.body?.uids) ? req.body.uids : [];
    const uids = Array.from(new Set(
      rawUids
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    ));

    if (uids.length === 0) {
      return res.status(400).json({ error: 'Select at least one valid user account' });
    }

    const result = await grantVouchersToMembers(uids);

    res.json({
      ...result,
      message: `Voucher grant finished. Granted: ${result.granted}, Skipped: ${result.skippedCount}.`,
    });
  } catch (err) {
    console.error('[Voucher Mgmt] Grant selected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/voucher-management/:id/suspend
 * Suspend an active voucher
 * Body: { reason }
 */
router.put('/:id/suspend', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureVoucherTable();

    const voucherId = Number(req.params.id);
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Suspend reason is required' });
    }

    // Verify voucher exists and is active
    const [rows] = await pool.query(
      'SELECT id, status FROM voucherstab WHERE id = ?',
      [voucherId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (rows[0].status !== 1) {
      return res.status(400).json({
        error: `Cannot suspend voucher with status "${STATUS_MAP[rows[0].status] || rows[0].status}". Only active vouchers can be suspended.`,
      });
    }

    const adminUsername = req.session.adminusername || req.session.adminid;

    await pool.query(
      `UPDATE voucherstab
       SET status = 4, suspend_reason = ?, suspended_by = ?, suspended_at = NOW()
       WHERE id = ?`,
      [reason.trim(), adminUsername, voucherId]
    );

    res.json({ message: 'Voucher suspended successfully' });
  } catch (err) {
    console.error('[Voucher Mgmt] Suspend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/voucher-management/:id/unsuspend
 * Reactivate a suspended voucher (only if not expired)
 */
router.put('/:id/unsuspend', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureVoucherTable();

    const voucherId = Number(req.params.id);

    // Verify voucher exists, is suspended, and not expired
    const [rows] = await pool.query(
      'SELECT id, status, expiry_date FROM voucherstab WHERE id = ?',
      [voucherId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (rows[0].status !== 4) {
      return res.status(400).json({
        error: `Cannot unsuspend voucher with status "${STATUS_MAP[rows[0].status] || rows[0].status}". Only suspended vouchers can be reactivated.`,
      });
    }

    const expiryDate = new Date(rows[0].expiry_date);
    if (expiryDate < new Date()) {
      return res.status(400).json({
        error: 'Cannot unsuspend voucher — it has already expired.',
      });
    }

    await pool.query(
      `UPDATE voucherstab
       SET status = 1, suspend_reason = NULL, suspended_by = NULL, suspended_at = NULL
       WHERE id = ?`,
      [voucherId]
    );

    res.json({ message: 'Voucher reactivated successfully' });
  } catch (err) {
    console.error('[Voucher Mgmt] Unsuspend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/voucher-management/:id/transactions
 * Get transaction history for a specific voucher
 */
router.get('/:id/transactions', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTable();
    await ensureVoucherTxTable();

    const voucherId = Number(req.params.id);

    // Verify voucher exists
    const [voucherRows] = await pool.query(
      'SELECT id FROM voucherstab WHERE id = ?',
      [voucherId]
    );

    if (voucherRows.length === 0) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    const [transactions] = await pool.query(
      `SELECT id, uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date
       FROM voucher_transactionstab
       WHERE voucher_id = ?
       ORDER BY transaction_date DESC`,
      [voucherId]
    );

    res.json({
      transactions: transactions.map((t) => ({
        ...t,
        date: t.transaction_date,
        type: 'Voucher',
        amount: Number(t.total_value || 0),
        reference: `V-${t.voucher_id}-${t.id}`,
      })),
    });
  } catch (err) {
    console.error('[Voucher Mgmt] Transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
