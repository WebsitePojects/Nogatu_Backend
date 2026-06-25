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
const { TableQueryPager } = require('./tableQueryPager');

let voucherTableReady = false;
let voucherTxTableReady = false;
let voucherGrantTableReady = false;

async function ensureVoucherGrantTable() {
  if (voucherGrantTableReady) return;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.VOUCHER_GRANTS, 'Voucher grants');
  voucherGrantTableReady = true;
}

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
  Object.entries(VOUCHER_PRODUCT_CATALOG).map(([voucherKey, product]) => [product.code, { ...product, voucherKey }])
);
function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

// Product quantity is a positive integer. Clamp to [1, 100000] so a typo can never
// overflow a money column or starve a voucher; the wallet/voucher checks downstream
// are the real spend guard.
function clampQuantity(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 100000);
}

// Trim + bound a free-text note for storage (voucher_availmentstab.note VARCHAR(500)).
function normalizeNote(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  return text.slice(0, 500);
}

function toIsoStringOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function toDateOrNull(value) {
  const isoValue = toIsoStringOrNull(value);
  return isoValue ? new Date(isoValue) : null;
}

function parseAvailmentDate(value) {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Availment date is required');
  }
  return parsed;
}

function normalizeVoucherAvailmentItems(rawItems = []) {
  const normalizedItems = [];

  for (const rawItem of Array.isArray(rawItems) ? rawItems : []) {
    const selectedProduct = normalizeVoucherProductSelection(rawItem || {});
    const description = selectedProduct
      ? selectedProduct.name
      : String(rawItem?.description || rawItem?.label || rawItem?.item || '').trim();

    const quantity = clampQuantity(rawItem?.quantity ?? 1);

    // Resolve a per-UNIT price, then derive the LINE TOTAL = unit_amount × quantity.
    // Field priority:
    //   1. explicit `unitAmount` (new clients send this),
    //   2. legacy `amount` — historically the LINE TOTAL at an implicit quantity of 1,
    //      so it equals the unit price; honoring it keeps every existing caller exact,
    //   3. catalog price for a recognized product,
    //   4. 0 → dropped below.
    const explicitUnit = roundCurrency(rawItem?.unitAmount);
    const explicitAmount = roundCurrency(rawItem?.amount);
    let unitAmount;
    if (explicitUnit > 0) {
      unitAmount = explicitUnit;
    } else if (explicitAmount > 0) {
      unitAmount = explicitAmount;
    } else if (selectedProduct) {
      unitAmount = roundCurrency(selectedProduct.price);
    } else {
      unitAmount = 0;
    }

    const amount = roundCurrency(unitAmount * quantity);
    if (!description || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    normalizedItems.push({
      lineNo: normalizedItems.length + 1,
      description,
      quantity,
      unitAmount,
      amount,
      ...(selectedProduct ? {
        productCode: Number(selectedProduct.code),
        productKey: String(selectedProduct.voucherKey || rawItem?.productKey || '').trim(),
      } : {}),
    });
  }

  return {
    items: normalizedItems,
    totalAmount: roundCurrency(
      normalizedItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    ),
  };
}

function resolveVoucherAvailmentClaimUpdate({ currentStatus, now = new Date() }) {
  const status = String(currentStatus || 'requested').toLowerCase();
  if (status === 'claimed') {
    throw new Error('Voucher request is already claimed');
  }
  if (status !== 'requested') {
    throw new Error('Only requested voucher entries can be marked claimed');
  }

  return {
    nextStatus: 'claimed',
    claimedAt: (toDateOrNull(now) || new Date()).toISOString(),
  };
}

function resolveInitialVoucherAvailmentClaimState({
  requestSource = 'cashier',
  actorAdminId = null,
  actorAdmin = null,
  claimDate = new Date(),
}) {
  const source = String(requestSource || 'cashier').trim().toLowerCase() || 'cashier';
  if (source === 'member') {
    return {
      claimStatus: 'requested',
      claimedAt: null,
      claimedByAdminId: null,
      claimedByAdmin: null,
    };
  }

  return {
    claimStatus: 'claimed',
    claimedAt: (toDateOrNull(claimDate) || new Date()).toISOString(),
    claimedByAdminId: actorAdminId,
    claimedByAdmin: actorAdmin,
  };
}

function computeVoucherAvailmentBalanceUpdate({
  voucher,
  previousTotal = 0,
  nextTotal,
  now = new Date(),
}) {
  const currentRemaining = roundCurrency(voucher?.remaining_balance);
  const priorDeduction = roundCurrency(previousTotal);
  const requestedDeduction = roundCurrency(nextTotal);

  if (!Number.isFinite(requestedDeduction) || requestedDeduction <= 0) {
    throw new Error('Voucher availment total must be greater than 0');
  }

  const effectiveRemaining = roundCurrency(currentRemaining + priorDeduction);
  if (requestedDeduction > effectiveRemaining) {
    throw new Error('Voucher balance is not enough for this availment');
  }

  const nowDate = toDateOrNull(now) || new Date();
  let firstUsedAt = toIsoStringOrNull(voucher?.first_used_at);
  let useExpiresAt = toIsoStringOrNull(voucher?.use_expires_at);

  if (!firstUsedAt) {
    firstUsedAt = nowDate.toISOString();
    const firstUseDays = Number(USED_VOUCHER_EXPIRY_DAYS[Number(voucher?.package_type || 0)] || 0);
    if (firstUseDays > 0) {
      useExpiresAt = new Date(nowDate.getTime() + (firstUseDays * 86400000)).toISOString();
    }
  }

  const remainingBalance = roundCurrency(effectiveRemaining - requestedDeduction);
  const status = remainingBalance <= 0 ? 3 : 1;

  return {
    firstUsedAt,
    useExpiresAt,
    remainingBalance,
    status,
    redeemedAt: status === 3 ? nowDate.toISOString() : null,
  };
}

function computeVoucherManualAvailmentWalletUpdate({
  walletBalance,
  previousTotal = 0,
  nextTotal,
}) {
  const currentWalletBalance = roundCurrency(walletBalance);
  const priorCashPaid = roundCurrency(previousTotal);
  const nextCashPaid = roundCurrency(nextTotal);

  if (!Number.isFinite(nextCashPaid) || nextCashPaid <= 0) {
    throw new Error('Voucher availment total must be greater than 0');
  }

  const cashDelta = roundCurrency(nextCashPaid - priorCashPaid);
  if (cashDelta > currentWalletBalance) {
    throw new Error('Insufficient wallet balance for this voucher availment');
  }

  return {
    cashDelta,
    cashPaid: nextCashPaid,
    voucherUsed: nextCashPaid,
    totalValue: roundCurrency(nextCashPaid * 2),
    walletBalance: roundCurrency(currentWalletBalance - cashDelta),
  };
}

function normalizeVoucherProductSelection(options = {}) {
  const productKey = String(options.productKey || '').trim().toLowerCase();
  if (productKey && VOUCHER_PRODUCT_CATALOG[productKey]) {
    return { ...VOUCHER_PRODUCT_CATALOG[productKey], voucherKey: productKey };
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
  const quantity = clampQuantity(options.quantity ?? 1);
  const note = normalizeNote(options.note);
  // Money authority: for a recognized catalog product the charge is computed
  // SERVER-SIDE as price × quantity — the client-sent cashAmount is never trusted
  // for product purchases (only legacy non-product top-ups still use it). This lets
  // a member spend a whole voucher on one product by raising the quantity.
  const productCharge = selectedProduct ? roundCurrency(Number(selectedProduct.price) * quantity) : null;
  const charge = productCharge != null ? productCharge : cashPaid;
  if (!Number.isFinite(charge) || charge <= 0) {
    throw new Error('Checkout amount must be greater than 0');
  }
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
    if (charge > currentWalletBalance) {
      throw new Error('Insufficient wallet balance for this checkout');
    }

    // Buy 1 Take 1: voucher deduction must fully match the wallet cash paid (charge).
    if (remaining < charge) {
      throw new Error('Voucher balance is not enough for this product quantity');
    }
    const voucherDeduction = charge;

    const newBalance = remaining - voucherDeduction;
    const newStatus = newBalance <= 0 ? 3 : 1;
    const newWalletBalance = currentWalletBalance - charge;
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

    const requestReference = `VREQ-${resolvedVoucherId}-${Date.now()}`;
    const [transactionResult] = await conn.query(
      `INSERT INTO voucher_transactionstab
        (uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date, source_type, external_reference)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), 'voucher_product_request', ?)`,
      [memberUid, resolvedVoucherId, charge, voucherDeduction, charge + voucherDeduction, requestReference]
    );

    if (selectedProduct) {
      const [availmentResult] = await conn.query(
        `INSERT INTO voucher_availmentstab
          (voucher_id, uid, er_number, availment_date, total_amount, note, transaction_id, request_source, claim_status)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, 'member', 'requested')`,
        [
          resolvedVoucherId,
          memberUid,
          requestReference,
          voucherDeduction,
          note,
          Number(transactionResult.insertId || 0),
        ]
      );
      const availmentId = Number(availmentResult.insertId || 0);
      await replaceVoucherAvailmentItems(conn, availmentId, [{
        lineNo: 1,
        description: selectedProduct.name,
        quantity,
        unitAmount: roundCurrency(selectedProduct.price),
        amount: voucherDeduction,
        productCode: selectedProduct.code,
        productKey: selectedProduct.voucherKey,
      }]);
      await conn.query(
        'UPDATE voucher_transactionstab SET availment_id = ? WHERE id = ? LIMIT 1',
        [availmentId, Number(transactionResult.insertId || 0)]
      );

      const voucherReferenceCode = `VC${Date.now().toString(36).toUpperCase().slice(-10)}`;
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
      cashPaid: charge,
      voucherDeducted: voucherDeduction,
      totalProductValue: charge + voucherDeduction,
      remainingBalance: newBalance,
      walletBalance: newWalletBalance,
      fullyUsed: newStatus === 3,
      productType: selectedProduct?.code || null,
      ...(selectedProduct ? { quantity } : {}),
      ...(note ? { note } : {}),
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
    `SELECT vt.id, vt.uid, vt.voucher_id, vt.cash_paid, vt.voucher_used, vt.total_value,
            vt.source_type, vt.availment_id, vt.external_reference,
            a.note,
            DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') as transaction_date
     FROM voucher_transactionstab vt
     LEFT JOIN voucher_availmentstab a ON a.id = vt.availment_id
     WHERE vt.uid = ?
     ORDER BY vt.id DESC
     LIMIT 100`,
    [uid]
  );

  return rows;
}

function assertVoucherManualAvailmentAllowed(voucher, { allowFullyUsed = false } = {}) {
  if (!voucher) {
    throw new Error('Voucher not found');
  }

  const status = Number(voucher.status || 0);
  if (status === 4) {
    throw new Error('Suspended vouchers cannot be edited');
  }
  if (!allowFullyUsed && status === 3) {
    throw new Error('Voucher is already fully used');
  }

  const now = Date.now();
  const unusedExpiry = voucher.first_used_at ? null : toDateOrNull(voucher.expiry_date);
  const usedExpiry = voucher.first_used_at ? toDateOrNull(voucher.use_expires_at) : null;
  if ((unusedExpiry && unusedExpiry.getTime() < now) || (usedExpiry && usedExpiry.getTime() < now) || status === 2) {
    throw new Error('Expired vouchers cannot be edited');
  }
}

async function replaceVoucherAvailmentItems(conn, availmentId, items) {
  await conn.query('DELETE FROM voucher_availment_itemstab WHERE availment_id = ?', [availmentId]);
  for (const item of items) {
    const quantity = clampQuantity(item.quantity ?? 1);
    // unit_amount = explicit unit, else derive from the line total so amount stays
    // the money-of-record (unit_amount × quantity === amount).
    const unitAmount = roundCurrency(
      item.unitAmount != null ? item.unitAmount : (Number(item.amount || 0) / quantity)
    );
    await conn.query(
      `INSERT INTO voucher_availment_itemstab (availment_id, line_no, product_code, product_key, item_label, quantity, unit_amount, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        availmentId,
        item.lineNo,
        item.productCode || null,
        item.productKey || null,
        item.description,
        quantity,
        unitAmount,
        item.amount,
      ]
    );
  }
}

async function getVoucherAvailmentItemsByAvailmentIds(conn, availmentIds = []) {
  const cleanIds = Array.from(new Set(
    (Array.isArray(availmentIds) ? availmentIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));

  if (cleanIds.length === 0) {
    return new Map();
  }

  const placeholders = cleanIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT availment_id, line_no, product_code, product_key, item_label, quantity, unit_amount, amount
     FROM voucher_availment_itemstab
     WHERE availment_id IN (${placeholders})
     ORDER BY availment_id ASC, line_no ASC, id ASC`,
    cleanIds
  );

  const itemMap = new Map();
  for (const row of rows) {
    const availmentId = Number(row.availment_id || 0);
    if (!itemMap.has(availmentId)) itemMap.set(availmentId, []);
    const quantity = clampQuantity(row.quantity ?? 1);
    const amount = Number(row.amount || 0);
    itemMap.get(availmentId).push({
      lineNo: Number(row.line_no || 0),
      description: row.item_label,
      quantity,
      unitAmount: row.unit_amount != null ? Number(row.unit_amount) : roundCurrency(amount / quantity),
      amount,
      productCode: row.product_code ? Number(row.product_code) : null,
      productKey: row.product_key || null,
    });
  }

  return itemMap;
}

function formatVoucherAvailmentRow(row, items = []) {
  return {
    id: Number(row.id),
    voucherId: Number(row.voucher_id),
    uid: Number(row.uid),
    erNumber: row.er_number,
    availmentDate: row.availment_date,
    totalAmount: Number(row.total_amount || 0),
    note: row.note || null,
    requestSource: row.request_source || 'cashier',
    claimStatus: row.claim_status || 'requested',
    claimedAt: row.claimed_at || null,
    claimedBy: row.claimed_by_admin || null,
    itemCount: Array.isArray(items) && items.length > 0 ? items.length : Number(row.item_count || 0),
    reference: row.external_reference || row.er_number || `ERA-${row.id}`,
    transactionId: row.transaction_id ? Number(row.transaction_id) : null,
    createdBy: row.created_by_admin || null,
    updatedBy: row.updated_by_admin || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    items,
  };
}

async function fetchVoucherAvailmentRecord(conn, availmentId) {
  const [rows] = await conn.query(
    `SELECT a.id, a.voucher_id, a.uid, a.er_number,
            DATE_FORMAT(a.availment_date, '%Y-%m-%d %H:%i') AS availment_date,
            a.total_amount, a.note, a.transaction_id, a.request_source, a.claim_status,
            DATE_FORMAT(a.claimed_at, '%Y-%m-%d %H:%i') AS claimed_at,
            a.claimed_by_admin,
            a.created_by_admin, a.updated_by_admin,
            DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
            DATE_FORMAT(a.updated_at, '%Y-%m-%d %H:%i') AS updated_at,
            tx.external_reference
     FROM voucher_availmentstab a
     LEFT JOIN voucher_transactionstab tx ON tx.availment_id = a.id
     WHERE a.id = ?
     LIMIT 1`,
    [availmentId]
  );

  return rows[0] || null;
}

async function getVoucherAvailments(voucherId) {
  await ensureVoucherTxTable();

  const safeVoucherId = Number(voucherId || 0);
  if (!Number.isFinite(safeVoucherId) || safeVoucherId <= 0) {
    throw new Error('Invalid voucher ID');
  }

  const [rows] = await pool.query(
    `SELECT a.id, a.voucher_id, a.uid, a.er_number,
            DATE_FORMAT(a.availment_date, '%Y-%m-%d %H:%i') AS availment_date,
            a.total_amount, a.note, a.transaction_id, a.request_source, a.claim_status,
            DATE_FORMAT(a.claimed_at, '%Y-%m-%d %H:%i') AS claimed_at,
            a.claimed_by_admin,
            a.created_by_admin, a.updated_by_admin,
            DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
            DATE_FORMAT(a.updated_at, '%Y-%m-%d %H:%i') AS updated_at,
            tx.external_reference,
            COUNT(i.id) AS item_count
     FROM voucher_availmentstab a
     LEFT JOIN voucher_availment_itemstab i ON i.availment_id = a.id
     LEFT JOIN voucher_transactionstab tx ON tx.availment_id = a.id
     WHERE a.voucher_id = ?
     GROUP BY a.id
     ORDER BY a.availment_date DESC, a.id DESC`,
    [safeVoucherId]
  );

  return rows.map((row) => formatVoucherAvailmentRow(row));
}

async function getVoucherAvailmentById(availmentId) {
  await ensureVoucherTxTable();

  const safeAvailmentId = Number(availmentId || 0);
  if (!Number.isFinite(safeAvailmentId) || safeAvailmentId <= 0) {
    throw new Error('Invalid availment ID');
  }

  const row = await fetchVoucherAvailmentRecord(pool, safeAvailmentId);
  if (!row) {
    throw new Error('Voucher availment not found');
  }

  const itemsMap = await getVoucherAvailmentItemsByAvailmentIds(pool, [safeAvailmentId]);
  return formatVoucherAvailmentRow(row, itemsMap.get(safeAvailmentId) || []);
}

async function appendVoucherAvailmentAudit(conn, {
  availmentId,
  voucherId,
  actionType,
  actorAdminId = null,
  actorAdmin = null,
  beforeState = null,
  afterState = null,
}) {
  await conn.query(
    `INSERT INTO voucher_availment_audittab
      (availment_id, voucher_id, action_type, actor_admin_id, actor_admin, snapshot_before, snapshot_after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      availmentId,
      voucherId,
      actionType,
      actorAdminId,
      actorAdmin,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null,
    ]
  );
}

async function createManualVoucherAvailment({
  voucherId,
  availmentDate,
  erNumber,
  items,
  note,
  actorAdminId = null,
  actorAdmin = null,
  requestSource = 'cashier',
}) {
  await ensureVoucherTxTable();

  const safeVoucherId = Number(voucherId || 0);
  if (!Number.isFinite(safeVoucherId) || safeVoucherId <= 0) {
    throw new Error('Invalid voucher ID');
  }

  const safeErNumber = String(erNumber || '').trim();
  if (!safeErNumber) {
    throw new Error('ER number is required');
  }

  const safeNote = normalizeNote(note);

  const normalized = normalizeVoucherAvailmentItems(items);
  if (normalized.items.length === 0) {
    throw new Error('At least one availed item is required');
  }

  const safeAvailmentDate = parseAvailmentDate(availmentDate);
  const claimState = resolveInitialVoucherAvailmentClaimState({
    requestSource,
    actorAdminId,
    actorAdmin,
    claimDate: safeAvailmentDate,
  });
  const conn = await pool.getConnection();
  const lockKey = `nogatu_voucher_availment_${safeVoucherId}`;
  let lockAcquired = false;
  let txStarted = false;

  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) {
      throw new Error('Unable to edit voucher right now. Please retry.');
    }

    await conn.beginTransaction();
    txStarted = true;

    const [voucherRows] = await conn.query(
      'SELECT * FROM voucherstab WHERE id = ? LIMIT 1 FOR UPDATE',
      [safeVoucherId]
    );
    const voucher = voucherRows[0];
    assertVoucherManualAvailmentAllowed(voucher);

    const balanceUpdate = computeVoucherAvailmentBalanceUpdate({
      voucher,
      previousTotal: 0,
      nextTotal: normalized.totalAmount,
      now: safeAvailmentDate,
    });
    const [walletRows] = await conn.query(
      'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE',
      [Number(voucher.uid || 0)]
    );
    if (walletRows.length === 0) {
      throw new Error('Member wallet balance was not found');
    }
    const walletUpdate = computeVoucherManualAvailmentWalletUpdate({
      walletBalance: walletRows[0].ttlcashbalance,
      previousTotal: 0,
      nextTotal: normalized.totalAmount,
    });

    const [availmentResult] = await conn.query(
      `INSERT INTO voucher_availmentstab
        (voucher_id, uid, er_number, availment_date, total_amount, note, request_source, claim_status, claimed_at, claimed_by_admin_id, claimed_by_admin, created_by_admin_id, created_by_admin, updated_by_admin_id, updated_by_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safeVoucherId,
        Number(voucher.uid || 0),
        safeErNumber,
        safeAvailmentDate,
        normalized.totalAmount,
        safeNote,
        String(requestSource || 'cashier').trim() || 'cashier',
        claimState.claimStatus,
        toDateOrNull(claimState.claimedAt),
        claimState.claimedByAdminId,
        claimState.claimedByAdmin,
        actorAdminId,
        actorAdmin,
        actorAdminId,
        actorAdmin,
      ]
    );

    const availmentId = Number(availmentResult.insertId || 0);
    await replaceVoucherAvailmentItems(conn, availmentId, normalized.items);

    const [transactionResult] = await conn.query(
      // transaction_date = server NOW() so the transaction-history ordering is
      // consistent with income rows (which use CURRENT_TIMESTAMP). The admin-supplied
      // availment date is preserved separately in voucher_availmentstab.availment_date.
      // Mixing a JS Date here with NOW() elsewhere caused wrong ordering / timezone drift.
      `INSERT INTO voucher_transactionstab
        (uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date, source_type, availment_id, external_reference)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), 'manual_availment', ?, ?)`,
      [
        Number(voucher.uid || 0),
        safeVoucherId,
        walletUpdate.cashPaid,
        walletUpdate.voucherUsed,
        walletUpdate.totalValue,
        availmentId,
        safeErNumber,
      ]
    );

    await conn.query(
      'UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = NOW() WHERE uid = ? LIMIT 1',
      [
        walletUpdate.walletBalance,
        Number(voucher.uid || 0),
      ]
    );

    await conn.query(
      'UPDATE voucher_availmentstab SET transaction_id = ? WHERE id = ? LIMIT 1',
      [Number(transactionResult.insertId || 0), availmentId]
    );

    await conn.query(
      `UPDATE voucherstab
          SET remaining_balance = ?,
              status = ?,
              first_used_at = ?,
              use_expires_at = ?,
              redeemed_date = CASE
                WHEN ? = 3 THEN COALESCE(redeemed_date, ?)
                ELSE NULL
              END
        WHERE id = ? LIMIT 1`,
      [
        balanceUpdate.remainingBalance,
        balanceUpdate.status,
        toDateOrNull(balanceUpdate.firstUsedAt),
        toDateOrNull(balanceUpdate.useExpiresAt),
        balanceUpdate.status,
        toDateOrNull(balanceUpdate.redeemedAt),
        safeVoucherId,
      ]
    );

    const createdRecord = await fetchVoucherAvailmentRecord(conn, availmentId);
    const createdItems = normalized.items;
    const response = formatVoucherAvailmentRow(createdRecord, createdItems);

    await appendVoucherAvailmentAudit(conn, {
      availmentId,
      voucherId: safeVoucherId,
      actionType: 'created',
      actorAdminId,
      actorAdmin,
      afterState: response,
    });

    await conn.commit();
    txStarted = false;

    return response;
  } catch (error) {
    if (txStarted) {
      await conn.rollback();
    }
    throw error;
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

async function markVoucherAvailmentClaimed({
  availmentId,
  actorAdminId = null,
  actorAdmin = null,
}) {
  await ensureVoucherTxTable();

  const safeAvailmentId = Number(availmentId || 0);
  if (!Number.isFinite(safeAvailmentId) || safeAvailmentId <= 0) {
    throw new Error('Invalid availment ID');
  }

  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    await conn.beginTransaction();
    txStarted = true;

    const [rows] = await conn.query(
      'SELECT * FROM voucher_availmentstab WHERE id = ? LIMIT 1 FOR UPDATE',
      [safeAvailmentId]
    );
    const existing = rows[0];
    if (!existing) {
      throw new Error('Voucher request not found');
    }

    const beforeItemsMap = await getVoucherAvailmentItemsByAvailmentIds(conn, [safeAvailmentId]);
    const beforeState = formatVoucherAvailmentRow(
      await fetchVoucherAvailmentRecord(conn, safeAvailmentId),
      beforeItemsMap.get(safeAvailmentId) || []
    );
    const claimUpdate = resolveVoucherAvailmentClaimUpdate({
      currentStatus: existing.claim_status,
      now: new Date(),
    });

    await conn.query(
      `UPDATE voucher_availmentstab
          SET claim_status = ?,
              claimed_at = ?,
              claimed_by_admin_id = ?,
              claimed_by_admin = ?,
              updated_by_admin_id = ?,
              updated_by_admin = ?
        WHERE id = ? LIMIT 1`,
      [
        claimUpdate.nextStatus,
        toDateOrNull(claimUpdate.claimedAt),
        actorAdminId,
        actorAdmin,
        actorAdminId,
        actorAdmin,
        safeAvailmentId,
      ]
    );

    const response = formatVoucherAvailmentRow(
      await fetchVoucherAvailmentRecord(conn, safeAvailmentId),
      beforeItemsMap.get(safeAvailmentId) || []
    );

    await appendVoucherAvailmentAudit(conn, {
      availmentId: safeAvailmentId,
      voucherId: Number(existing.voucher_id || 0),
      actionType: 'claimed',
      actorAdminId,
      actorAdmin,
      beforeState,
      afterState: response,
    });

    await conn.commit();
    txStarted = false;
    return response;
  } catch (error) {
    if (txStarted) {
      await conn.rollback();
    }
    throw error;
  } finally {
    conn.release();
  }
}

async function updateManualVoucherAvailment({
  availmentId,
  availmentDate,
  erNumber,
  items,
  note,
  actorAdminId = null,
  actorAdmin = null,
}) {
  await ensureVoucherTxTable();

  const safeAvailmentId = Number(availmentId || 0);
  if (!Number.isFinite(safeAvailmentId) || safeAvailmentId <= 0) {
    throw new Error('Invalid availment ID');
  }

  const safeErNumber = String(erNumber || '').trim();
  if (!safeErNumber) {
    throw new Error('ER number is required');
  }

  // note === undefined → caller did not send the field → keep the existing note.
  const noteProvided = note !== undefined;
  const safeNote = noteProvided ? normalizeNote(note) : null;

  const normalized = normalizeVoucherAvailmentItems(items);
  if (normalized.items.length === 0) {
    throw new Error('At least one availed item is required');
  }

  const safeAvailmentDate = parseAvailmentDate(availmentDate);
  const conn = await pool.getConnection();
  let lockAcquired = false;
  let txStarted = false;
  let lockKey = null;

  try {
    await conn.beginTransaction();
    txStarted = true;

    const [availmentRows] = await conn.query(
      'SELECT * FROM voucher_availmentstab WHERE id = ? LIMIT 1 FOR UPDATE',
      [safeAvailmentId]
    );
    const existingAvailment = availmentRows[0];
    if (!existingAvailment) {
      throw new Error('Voucher availment not found');
    }

    lockKey = `nogatu_voucher_availment_${Number(existingAvailment.voucher_id || 0)}`;
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) {
      throw new Error('Unable to edit voucher right now. Please retry.');
    }

    const [voucherRows] = await conn.query(
      'SELECT * FROM voucherstab WHERE id = ? LIMIT 1 FOR UPDATE',
      [Number(existingAvailment.voucher_id || 0)]
    );
    const voucher = voucherRows[0];
    assertVoucherManualAvailmentAllowed(voucher, { allowFullyUsed: true });

    const beforeItemsMap = await getVoucherAvailmentItemsByAvailmentIds(conn, [safeAvailmentId]);
    const beforeState = formatVoucherAvailmentRow(
      await fetchVoucherAvailmentRecord(conn, safeAvailmentId),
      beforeItemsMap.get(safeAvailmentId) || []
    );

    const balanceUpdate = computeVoucherAvailmentBalanceUpdate({
      voucher,
      previousTotal: Number(existingAvailment.total_amount || 0),
      nextTotal: normalized.totalAmount,
      now: safeAvailmentDate,
    });
    const [walletRows] = await conn.query(
      'SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE',
      [Number(voucher.uid || 0)]
    );
    if (walletRows.length === 0) {
      throw new Error('Member wallet balance was not found');
    }
    const walletUpdate = computeVoucherManualAvailmentWalletUpdate({
      walletBalance: walletRows[0].ttlcashbalance,
      previousTotal: Number(existingAvailment.total_amount || 0),
      nextTotal: normalized.totalAmount,
    });

    await conn.query(
      `UPDATE voucher_availmentstab
          SET er_number = ?,
              availment_date = ?,
              total_amount = ?,
              ${noteProvided ? 'note = ?,' : ''}
              updated_by_admin_id = ?,
              updated_by_admin = ?
        WHERE id = ? LIMIT 1`,
      [
        safeErNumber,
        safeAvailmentDate,
        normalized.totalAmount,
        ...(noteProvided ? [safeNote] : []),
        actorAdminId,
        actorAdmin,
        safeAvailmentId,
      ]
    );

    await replaceVoucherAvailmentItems(conn, safeAvailmentId, normalized.items);

    if (existingAvailment.transaction_id) {
      await conn.query(
        `UPDATE voucher_transactionstab
            SET cash_paid = ?,
                voucher_used = ?,
                total_value = ?,
                transaction_date = ?,
                source_type = 'manual_availment',
                availment_id = ?,
                external_reference = ?
          WHERE id = ? LIMIT 1`,
        [
          walletUpdate.cashPaid,
          walletUpdate.voucherUsed,
          walletUpdate.totalValue,
          safeAvailmentDate,
          safeAvailmentId,
          safeErNumber,
          Number(existingAvailment.transaction_id || 0),
        ]
      );
    } else {
      const [transactionResult] = await conn.query(
        // transaction_date = server NOW() for consistent transaction-history ordering
        // (availment date is preserved in voucher_availmentstab.availment_date).
        `INSERT INTO voucher_transactionstab
          (uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date, source_type, availment_id, external_reference)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), 'manual_availment', ?, ?)`,
        [
          Number(voucher.uid || 0),
          Number(existingAvailment.voucher_id || 0),
          walletUpdate.cashPaid,
          walletUpdate.voucherUsed,
          walletUpdate.totalValue,
          safeAvailmentId,
          safeErNumber,
        ]
      );

      await conn.query(
        'UPDATE voucher_availmentstab SET transaction_id = ? WHERE id = ? LIMIT 1',
        [Number(transactionResult.insertId || 0), safeAvailmentId]
      );
    }

    await conn.query(
      'UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = NOW() WHERE uid = ? LIMIT 1',
      [
        walletUpdate.walletBalance,
        Number(voucher.uid || 0),
      ]
    );

    await conn.query(
      `UPDATE voucherstab
          SET remaining_balance = ?,
              status = ?,
              first_used_at = ?,
              use_expires_at = ?,
              redeemed_date = CASE
                WHEN ? = 3 THEN COALESCE(redeemed_date, ?)
                ELSE NULL
              END
        WHERE id = ? LIMIT 1`,
      [
        balanceUpdate.remainingBalance,
        balanceUpdate.status,
        toDateOrNull(balanceUpdate.firstUsedAt),
        toDateOrNull(balanceUpdate.useExpiresAt),
        balanceUpdate.status,
        toDateOrNull(balanceUpdate.redeemedAt),
        Number(existingAvailment.voucher_id || 0),
      ]
    );

    const response = formatVoucherAvailmentRow(
      await fetchVoucherAvailmentRecord(conn, safeAvailmentId),
      normalized.items
    );

    await appendVoucherAvailmentAudit(conn, {
      availmentId: safeAvailmentId,
      voucherId: Number(existingAvailment.voucher_id || 0),
      actionType: 'updated',
      actorAdminId,
      actorAdmin,
      beforeState,
      afterState: response,
    });

    await conn.commit();
    txStarted = false;
    return response;
  } catch (error) {
    if (txStarted) {
      await conn.rollback();
    }
    throw error;
  } finally {
    if (lockAcquired && lockKey) {
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
  return listVoucherGrantCandidates({ page, perPage, search, includeAll: false });
}

async function listVoucherGrantCandidates({
  page = 1,
  perPage = 30,
  search = '',
  includeAll = false,
  queryExecutor = pool,
} = {}) {
  await ensureVoucherGrantTable();

  const pager = new TableQueryPager(queryExecutor);
  const safeIncludeAll = includeAll === true || includeAll === '1' || includeAll === 'true';
  const filters = [
    'u.uid = u.mainid',
    'u.currentaccttype IN (10,20,30,40,50,60)',
  ];
  const params = [];

  const keyword = String(search || '').trim();
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push('(m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ? OR CAST(u.uid AS CHAR) LIKE ?)');
    params.push(like, like, like, like);
  }

  if (!safeIncludeAll) {
    filters.push('NOT EXISTS (SELECT 1 FROM voucherstab v WHERE v.uid = u.uid)');
  }

  const whereSql = `WHERE ${filters.join(' AND ')}`;
  const pageResult = await pager.fetchPage({
    page,
    perPage,
    countSql: `SELECT COUNT(*) AS total
               FROM usertab u
               INNER JOIN memberstab m ON m.uid = u.uid
               ${whereSql}`,
    countParams: params,
    dataSql: `SELECT u.uid, u.currentaccttype, u.accttype,
                     DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg,
                     m.username, m.firstname, m.lastname
              FROM usertab u
              INNER JOIN memberstab m ON m.uid = u.uid
              ${whereSql}
              ORDER BY u.datereg DESC, u.uid DESC`,
    dataParams: params,
  });

  let voucherRowsByUid = new Map();
  if (safeIncludeAll && pageResult.rows.length > 0) {
    voucherRowsByUid = await pager.fetchByKeys({
      rows: pageResult.rows,
      rowKey: 'uid',
      keyField: 'uid',
      mode: 'first',
      queryFactory: (placeholders) => `
        SELECT uid, id, remaining_balance, status
        FROM voucherstab
        WHERE uid IN (${placeholders})
        ORDER BY uid ASC,
                 CASE status
                   WHEN 1 THEN 0
                   WHEN 4 THEN 1
                   WHEN 2 THEN 2
                   WHEN 3 THEN 3
                   ELSE 4
                 END ASC,
                 id DESC`,
      mapRow: (row) => ({
        voucherId: Number(row.id || 0),
        voucherRemaining: row.remaining_balance != null ? Number(row.remaining_balance) : null,
        voucherStatus: row.status != null ? Number(row.status) : null,
      }),
    });
  }

  return {
    users: pageResult.rows.map((row) => {
      const uid = Number(row.uid);
      const accttype = Number(row.currentaccttype || row.accttype || 0);
      const voucherRow = voucherRowsByUid.get(uid) || null;
      return {
        uid,
        username: row.username,
        firstname: row.firstname,
        lastname: row.lastname,
        fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
        accttype,
        voucherAmount: Number(PACKAGE_AMOUNTS[accttype] || 0),
        datereg: row.datereg,
        hasVoucher: Boolean(voucherRow),
        voucherId: voucherRow?.voucherId || null,
        voucherRemaining: voucherRow?.voucherRemaining ?? null,
        voucherStatus: voucherRow?.voucherStatus ?? null,
      };
    }),
    total: pageResult.pagination.total,
    page: pageResult.pagination.page,
    perPage: pageResult.pagination.perPage,
    totalPages: pageResult.pagination.totalPages,
  };
}

/**
 * Grant vouchers to selected members.
 * Members with existing voucher history are skipped.
 */
async function grantVouchersToMembers(uids = []) {
  await ensureVoucherGrantTable();

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
  await ensureVoucherGrantTable();

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
  listVoucherGrantCandidates,
  grantVouchersToMembers,
  grantVouchersToExistingMembers,
  ensureVoucherGrantTable,
  ensureVoucherTable,
  ensureVoucherTxTable,
  normalizeVoucherProductSelection,
  normalizeVoucherAvailmentItems,
  computeVoucherAvailmentBalanceUpdate,
  computeVoucherManualAvailmentWalletUpdate,
  resolveVoucherAvailmentClaimUpdate,
  resolveInitialVoucherAvailmentClaimState,
  getVoucherAvailments,
  getVoucherAvailmentById,
  createManualVoucherAvailment,
  markVoucherAvailmentClaimed,
  updateManualVoucherAvailment,
  VOUCHER_PRODUCT_CATALOG,
  UNUSED_VOUCHER_EXPIRY_MONTHS,
  USED_VOUCHER_EXPIRY_DAYS,
  PACKAGE_AMOUNTS,
  buildVoucherExpiryLabel,
  getVoucherExpiryMode,
  getVoucherRepurchasePoints,
};
