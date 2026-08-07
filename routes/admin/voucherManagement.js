const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { idempotent } = require('../../middleware/idempotency');
const { getAccountTypeName } = require('../../utils/helpers');
const {
  buildVoucherExpiryLabel,
  createManualVoucherAvailment,
  getVoucherExpiryMode,
  getVoucherAvailmentById,
  getVoucherAvailments,
  isEligibleForPackageVoucher,
  issuePackageVoucher,
  listVoucherGrantCandidates,
  resolveVoucherSources,
  markVoucherAvailmentClaimed,
  updateManualVoucherAvailment,
} = require('../../services/voucher');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../../services/schemaReadiness');

// Hard cap on a single grant batch — bounds worst-case connection/transaction fan-out
// per request and gives a clear 400 instead of a slow/huge silent loop.
const MAX_GRANT_BATCH_SIZE = 500;

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
      // the voucher owner used — codestab.code), the underlying Code ID (codestab.id), or by
      // username. The code/Code ID is what the cashier tracks; the internal voucher id/ER is
      // not part of their workflow.
      //
      // Perf: resolve matching voucher owners FIRST via small bounded indexed queries, then
      // filter vouchers by a literal uid list. Never leave LIKE subqueries inside the voucher
      // query — the optimizer can degrade them to per-outer-row execution (the minutes-long
      // prod search). Fuzzy match only where cheap and useful (username / code contains);
      // Code ID and the VCH voucher id are exact indexed point lookups.
      const pattern = `%${search}%`;
      const matchedUids = new Set();

      const [usernameRows] = await pool.query(
        'SELECT uid FROM memberstab WHERE username LIKE ? LIMIT 1000',
        [pattern]
      );
      for (const row of usernameRows) matchedUids.add(Number(row.uid));

      const [codeRows] = await pool.query(
        `SELECT DISTINCT to_uid FROM activation_code_usagetab
          WHERE code LIKE ? AND to_uid IS NOT NULL
          LIMIT 1000`,
        [pattern]
      );
      for (const row of codeRows) matchedUids.add(Number(row.to_uid));

      // Digits or "VCH-000123": exact Code ID (usage code_row_id / codestab PK) plus the
      // voucher's own displayed VCH id (voucherstab PK).
      const idMatch = search.match(/^(?:VCH-?)?0*(\d{1,10})$/i);
      const numericId = idMatch ? Number(idMatch[1]) : null;
      if (numericId !== null) {
        const [idRows] = await pool.query(
          `SELECT DISTINCT acu.to_uid
             FROM activation_code_usagetab acu
            WHERE acu.to_uid IS NOT NULL
              AND (acu.code_row_id = ?
                   OR acu.code IN (SELECT code FROM codestab WHERE id = ?))
            LIMIT 1000`,
          [numericId, numericId]
        );
        for (const row of idRows) matchedUids.add(Number(row.to_uid));
      }

      const ors = [];
      const searchParams = [];
      if (matchedUids.size > 0) {
        const uidList = [...matchedUids];
        ors.push(`v.uid IN (${uidList.map(() => '?').join(',')})`);
        searchParams.push(...uidList);
      }
      if (numericId !== null) {
        ors.push('v.id = ?');
        searchParams.push(numericId);
      }
      if (ors.length === 0) {
        // Nothing matches — keep the count/page queries trivially false instead of scanning.
        filters.push('1 = 0');
      } else {
        filters.push(`(${ors.join(' OR ')})`);
        params.push(...searchParams);
      }
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

    // Derived per page with a few bounded, uid-keyed queries (never correlated
    // subqueries per row — that is what made this screen slow enough for management
    // to report it). Guarantees every voucher reports a source, so the UI never has
    // to render an ambiguous blank Code cell.
    // FAIL SOFT: provenance is a display aid, not voucher data. If the lookup throws
    // (missing/partial schema on an older DB, upgradetab unavailable, ...) the admin
    // must still get their voucher list — degraded to "No record", never a 500.
    let sourceByVoucherId = new Map();
    try {
      sourceByVoucherId = await resolveVoucherSources(rows);
    } catch (sourceError) {
      console.error('[Admin Voucher Management] Voucher source resolution failed:', sourceError.message);
    }

    res.json({
      vouchers: rows.map((row) => {
        const expiryMode = getVoucherExpiryMode(row);
        const origin = sourceByVoucherId.get(Number(row.id)) || {
          source: 'unknown', sourceLabel: 'No record', code: null, codeId: null,
        };
        return {
          id: Number(row.id),
          code: origin.code,
          codeId: origin.codeId,
          source: origin.source,
          sourceLabel: origin.sourceLabel,
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
        `SELECT vt.id,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS transaction_date,
                vt.cash_paid, vt.voucher_used, vt.total_value,
                vt.source_type, vt.availment_id, vt.external_reference,
                a.note
         FROM voucher_transactionstab vt
         LEFT JOIN voucher_availmentstab a ON a.id = vt.availment_id
         WHERE vt.voucher_id = ?
         ORDER BY vt.transaction_date DESC, vt.id DESC`,
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
        note: row.note || null,
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
      note: req.body?.note,
      paymentMethod: req.body?.paymentMethod,
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
      note: req.body?.note,
      paymentMethod: req.body?.paymentMethod,
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

/*
 * REMOVED 2026-08-07: POST /api/admin/voucher-management/grant-existing
 *
 * It took NO request body and called grantVouchersToExistingMembers(), an
 * unbounded `INSERT ... SELECT ... WHERE v.uid IS NULL` — one authenticated
 * request issued a voucher to EVERY member without one. Measured on prod
 * 2026-08-07: 7,176 members / ₱40,755,000 of redeemable value, with no uid
 * list, no cap, and no confirmation. It was also tier-blind (`v.uid IS NULL`
 * excludes anyone holding ANY voucher), so it would have MISSED exactly the
 * upgraded members it was supposed to help while paying everyone else.
 *
 * No frontend ever called it (VoucherGrant.jsx uses POST /grant with an
 * explicit uid list). Use that route — per-uid, capped, idempotent, row-locked,
 * upgraded-only. Bulk-backfilling legacy members is a business decision and
 * must arrive as a reviewed script with sign-off, not an unguarded endpoint.
 */

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
      // Visibility only. An unrecognised value falls back to the narrowest view in
      // the service (fail closed), and no view can make a member grantable — every
      // row carries `grantable`, and POST /grant re-checks under a row lock.
      view: String(req.query.view || '').trim(),
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
 * Boundary validation for the grant batch: `uids` must be a non-empty array of
 * strictly positive integers (no numeric strings, no floats, no NaN), capped at
 * MAX_GRANT_BATCH_SIZE. ANY invalid element rejects the WHOLE request with 400 —
 * fail closed rather than silently dropping bad entries (money-integrity rule 3).
 * Returns { error } on failure, { uids } (deduped preserved-order) on success.
 */
function validateGrantUids(rawUids) {
  if (!Array.isArray(rawUids) || rawUids.length === 0) {
    return { error: 'At least one UID is required' };
  }

  if (rawUids.length > MAX_GRANT_BATCH_SIZE) {
    return { error: `Too many UIDs in one request — max ${MAX_GRANT_BATCH_SIZE}` };
  }

  const uids = [];
  for (const raw of rawUids) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      return { error: `Invalid UID in request: ${JSON.stringify(raw)}` };
    }
    uids.push(raw);
  }

  return { uids };
}

/**
 * POST /api/admin/voucher-management/grant
 *
 * Additive, per-uid grant using the shared eligibility/issue helpers so this
 * admin path can never diverge from the automatic upgrade-grant path. Each uid
 * is checked and inserted in its OWN connection + transaction so one bad uid in
 * a batch can never roll back or block the others. Never UPDATE/DELETE
 * voucherstab here — grants are INSERT-only, existing rows are left untouched.
 */
router.post('/grant', adminAuth, adminRights([1, 2, 3]), idempotent('admin.voucherManagement.grant'), async (req, res) => {
  const validation = validateGrantUids(req.body?.uids);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    await ensureVoucherGrantTables();
  } catch (error) {
    console.error('[Admin Voucher Management] Grant schema check error:', error);
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }

  const results = [];
  let granted = 0;
  let skipped = 0;

  for (const uid of validation.uids) {
    const connection = await pool.getConnection();
    let inTransaction = false;

    try {
      await connection.beginTransaction();
      inTransaction = true;

      // Lock the member row BEFORE the eligibility check so two concurrent
      // grants for the SAME uid (two admins, or one admin double-tapping with
      // different Idempotency-Keys) serialize instead of both reading "not yet
      // granted" and both inserting a real, money-value voucher. Do not remove.
      const [lockRows] = await connection.query(
        'SELECT uid FROM usertab WHERE uid = ? LIMIT 1 FOR UPDATE',
        [uid]
      );

      if (lockRows.length === 0) {
        await connection.rollback();
        inTransaction = false;
        skipped += 1;
        results.push({ uid, granted: false, reason: 'account_not_found', amount: null });
        continue;
      }

      const eligibility = await isEligibleForPackageVoucher(connection, uid);

      if (!eligibility?.eligible) {
        await connection.rollback();
        inTransaction = false;
        skipped += 1;
        results.push({
          uid,
          granted: false,
          reason: eligibility?.reason || 'not_eligible',
          amount: eligibility?.amount ?? null,
        });
        continue;
      }

      // NOTE (policy, 2026-08-07): an upgraded-only refusal (`not_upgraded`) used to
      // sit here. The account owner decided an admin may grant a voucher to ANY
      // member, upgraded or not, so it was removed deliberately — do not
      // reintroduce it as a "fix" without checking with them first.
      //
      // What that leaves as the only protection against a bulk over-issuance
      // (~7,177 members / ₱40,755,000 of redeemable value on prod):
      //   - MAX_GRANT_BATCH_SIZE on this route,
      //   - the confirmation total shown in the UI before submit,
      //   - `already_has_voucher_for_current_tier` from isEligibleForPackageVoucher,
      //     which is the DUPLICATE guard (vouchers are additive per tier) and is NOT
      //     a policy gate — it must stay.
      const insertedId = await issuePackageVoucher(connection, uid, eligibility.currentTier);

      if (!insertedId) {
        await connection.rollback();
        inTransaction = false;
        skipped += 1;
        results.push({ uid, granted: false, reason: 'grant_failed', amount: eligibility.amount ?? null });
        continue;
      }

      await connection.commit();
      inTransaction = false;
      granted += 1;
      results.push({ uid, granted: true, reason: 'eligible', amount: eligibility.amount ?? null });
    } catch (error) {
      if (inTransaction) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error(`[Admin Voucher Management] Grant rollback error for uid ${uid}:`, rollbackError);
        }
      }
      console.error(`[Admin Voucher Management] Grant error for uid ${uid}:`, error);
      skipped += 1;
      results.push({ uid, granted: false, reason: 'error', amount: null });
    } finally {
      connection.release();
    }
  }

  // `skippedCount` kept alongside `skipped` — the existing admin frontend
  // (VoucherGrant.jsx) reads `res.data.skippedCount`.
  res.json({ success: true, granted, skipped, skippedCount: skipped, results });
});

module.exports = router;
