const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAccountTypeName } = require('../../utils/helpers');
const {
  PACKAGE_AMOUNTS,
  buildVoucherExpiryLabel,
  createManualVoucherAvailment,
  grantVouchersToExistingMembers,
  getVoucherExpiryMode,
  getVoucherAvailmentById,
  getVoucherAvailments,
  listVoucherGrantCandidates,
  markVoucherAvailmentClaimed,
  updateManualVoucherAvailment,
  UNUSED_VOUCHER_EXPIRY_MONTHS,
} = require('../../services/voucher');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../../services/schemaReadiness');

async function ensureVoucherTables() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHERS, 'Voucher management');
}

async function ensureVoucherListTables() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHER_LIST, 'Voucher list');
}

async function ensureVoucherGrantTables() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHER_GRANTS, 'Voucher grants');
}

async function ensureVoucherTransactionTables() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHER_TRANSACTIONS, 'Voucher transactions');
}

router.use(adminAuth, adminRights([1, 2, 3]));

function normalizeVoucherStatus(raw) {
  const value = String(raw || 'all').toLowerCase();
  return ['1', '2', '3', '4'].includes(value) ? Number(value) : 'all';
}

/**
 * Human-readable, unique, searchable voucher code derived from the immutable PK.
 * Display/identity only — never used as a balance/amount key. Kept deterministic
 * (VCH-<6-digit id>) so it stays collision-free without touching voucherstab.
 */
function formatVoucherCode(id) {
  return `VCH-${String(Number(id) || 0).padStart(6, '0')}`;
}

function getVoucherActor(req) {
  return {
    actorAdminId: Number(req.session?.adminid || 0) || null,
    actorAdmin: String(req.session?.adminusername || req.session?.adminname || req.session?.username || '').trim() || null,
  };
}

function isOptionalVoucherDetailSchemaError(error) {
  return ['SCHEMA_NOT_READY', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.code);
}

function getVoucherTransactionType(row) {
  if (row.source_type === 'manual_availment') return 'Manual Voucher Availment';
  if (row.source_type === 'voucher_product_request') return 'Voucher Product Request';
  return 'Voucher Redemption';
}

/**
 * GET /api/admin/voucher-management
 */
router.get('/', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherListTables();

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
      // Cashier-centric trace: match by the ACTIVATION CODE the cashier distributed (any code
      // the voucher owner used — codestab.code), or by username. The code is what the cashier
      // tracks; the internal voucher id/ER is not part of their workflow.
      const pattern = `%${search}%`;
      const ors = [
        'm.username LIKE ?',
        'EXISTS (SELECT 1 FROM activation_code_usagetab acu WHERE acu.to_uid = v.uid AND acu.code LIKE ?)',
      ];
      const searchParams = [pattern, pattern];
      filters.push(`(${ors.join(' OR ')})`);
      params.push(...searchParams);
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
              DATE_FORMAT(v.first_used_at, '%Y-%m-%d %H:%i') AS first_used_at,
              DATE_FORMAT(v.use_expires_at, '%Y-%m-%d %H:%i') AS use_expires_at,
              (SELECT acu.code FROM activation_code_usagetab acu
                 WHERE acu.to_uid = v.uid
                 ORDER BY (acu.event_type = 'registration') DESC, acu.id ASC LIMIT 1) AS source_code,
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
      vouchers: rows.map((row) => {
        const expiryMode = getVoucherExpiryMode(row);
        return {
          id: Number(row.id),
          code: row.source_code || null,
          uid: Number(row.uid),
          username: row.username,
          fullName: `${row.firstname || ''} ${row.lastname || ''}`.trim() || null,
          package: getAccountTypeName(row.package_type),
          amount: Number(row.voucher_amount || 0),
          remaining: Number(row.remaining_balance || 0),
          status: Number(row.status || 0),
          issuedAt: row.issued_at,
          expiryAt: row.expiry_at,
          firstUsedAt: row.first_used_at,
          useExpiresAt: row.use_expires_at,
          expiryMode,
          expiryLabel: buildVoucherExpiryLabel({
            unusedExpiryDate: row.expiry_at,
            usedExpiryDate: row.use_expires_at,
            firstUsedAt: row.first_used_at,
            status: row.status,
          }),
          suspendReason: row.suspend_reason,
        };
      }),
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
    await ensureVoucherTransactionTables();
    const voucherId = Number(req.params.id);

    let rows;
    try {
      [rows] = await pool.query(
        `SELECT id,
                DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') AS transaction_date,
                cash_paid, voucher_used, total_value,
                source_type, availment_id, external_reference
         FROM voucher_transactionstab
         WHERE voucher_id = ?
         ORDER BY transaction_date DESC, id DESC`,
        [voucherId]
      );
    } catch (error) {
      if (!isOptionalVoucherDetailSchemaError(error)) throw error;
      [rows] = await pool.query(
        `SELECT id,
                DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') AS transaction_date,
                cash_paid, voucher_used, total_value
         FROM voucher_transactionstab
         WHERE voucher_id = ?
         ORDER BY transaction_date DESC, id DESC`,
        [voucherId]
      );
    }

    res.json({
      transactions: rows.map((row) => ({
        id: Number(row.id),
        date: row.transaction_date,
        type: getVoucherTransactionType(row),
        amount: Number(row.voucher_used || row.total_value || 0),
        reference: row.external_reference || (row.source_type === 'manual_availment' ? `ER-${row.availment_id}` : `VTX-${row.id}`),
        sourceType: row.source_type || 'member_checkout',
        availmentId: row.availment_id ? Number(row.availment_id) : null,
      })),
    });
  } catch (error) {
    console.error('[Admin Voucher Management] Transactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/availments', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const voucherId = Number(req.params.id);
    const availments = await getVoucherAvailments(voucherId);
    res.json({ availments });
  } catch (error) {
    if (isOptionalVoucherDetailSchemaError(error)) {
      return res.json({ availments: [] });
    }
    console.error('[Admin Voucher Management] Availment list error:', error);
    res.status(400).json({ error: error.message || 'Failed to load voucher availments' });
  }
});

router.post('/:id/availments', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const voucherId = Number(req.params.id);
    const availment = await createManualVoucherAvailment({
      voucherId,
      availmentDate: req.body?.availmentDate,
      erNumber: req.body?.erNumber,
      items: req.body?.items,
      ...getVoucherActor(req),
    });
    res.status(201).json({ success: true, availment });
  } catch (error) {
    console.error('[Admin Voucher Management] Availment create error:', error);
    res.status(400).json({ error: error.message || 'Failed to create voucher availment' });
  }
});

router.get('/availments/:availmentId', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const availment = await getVoucherAvailmentById(req.params.availmentId);
    res.json({ availment });
  } catch (error) {
    console.error('[Admin Voucher Management] Availment detail error:', error);
    res.status(404).json({ error: error.message || 'Voucher availment not found' });
  }
});

router.put('/availments/:availmentId', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const availment = await updateManualVoucherAvailment({
      availmentId: req.params.availmentId,
      availmentDate: req.body?.availmentDate,
      erNumber: req.body?.erNumber,
      items: req.body?.items,
      ...getVoucherActor(req),
    });
    res.json({ success: true, availment });
  } catch (error) {
    console.error('[Admin Voucher Management] Availment update error:', error);
    res.status(400).json({ error: error.message || 'Failed to update voucher availment' });
  }
});

router.put('/availments/:availmentId/claim', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    await ensureVoucherTables();
    const availment = await markVoucherAvailmentClaimed({
      availmentId: req.params.availmentId,
      ...getVoucherActor(req),
    });
    res.json({ success: true, availment });
  } catch (error) {
    console.error('[Admin Voucher Management] Availment claim error:', error);
    res.status(400).json({ error: error.message || 'Failed to mark voucher request as claimed' });
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
    await ensureVoucherGrantTables();
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
    await ensureVoucherGrantTables();
    const result = await listVoucherGrantCandidates({
      page: Number(req.query.page) || 1,
      perPage: 30,
      search: String(req.query.search || '').trim(),
      includeAll: req.query.includeAll === '1' || req.query.includeAll === 'true',
    });
    res.json(result);
  } catch (error) {
    console.error('[Admin Voucher Management] Grant candidates error:', error);
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/voucher-management/grant
 */
router.post('/grant', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await ensureVoucherGrantTables();

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
      const expiryMonths = Number(UNUSED_VOUCHER_EXPIRY_MONTHS[accttype] || 0);

      if (!voucherAmount || !expiryMonths) {
        skippedCount += 1;
        continue;
      }

      await connection.query(
        `INSERT INTO voucherstab
           (uid, package_type, voucher_amount, remaining_balance, issued_date, expiry_date, status)
         VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? MONTH), 1)`,
        [uid, accttype, voucherAmount, voucherAmount, expiryMonths]
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
