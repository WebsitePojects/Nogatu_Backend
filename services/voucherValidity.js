/**
 * Voucher validity extension (management meeting 2026-11-10).
 *
 * A voucher has TWO expiry clocks and only one of them governs at a time:
 *   first_used_at IS NULL     -> expiry_date      (unused clock)
 *   first_used_at IS NOT NULL -> use_expires_at   (used clock)
 * Extending the wrong column reports success and changes nothing at the counter, so the clock
 * is derived from the LOCKED row, never from the caller.
 *
 * Scope is deliberately narrow: this moves one date and resets status 2 -> 1. It never reads
 * or writes remaining_balance / voucher_amount / issued_date, and never touches the other clock.
 * Dates are formatted in server-local time; toISOString() would subtract 8h on this UTC+8 host.
 */

const MAX_EXTENSION_MONTHS_FROM_NOW = 6;
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;
const EXTENDABLE_STATUSES = [1, 2];

const STATUS_ERRORS = {
  3: ['FULLY_USED', 'Voucher is fully used and cannot be extended'],
  4: ['SUSPENDED', 'Voucher is suspended; unsuspend it before extending'],
  5: ['REVOKED', 'Voucher is revoked and cannot be extended'],
};

class VoucherValidityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoucherValidityError';
    this.code = code;
  }
}

function getPool() {
  // Resolved at call time so a missing/stubbed module is never touched at require time.
  return require('../config/database').pool;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local-time MySQL DATETIME string. Never toISOString(). */
function toMysqlLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 'YYYY-MM-DD' -> that day at 23:59:59 local. Real calendar dates only (no Feb 30). */
function parseExpiryDate(input) {
  if (typeof input !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d, 23, 59, 59, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** Add months, clamping the day so Aug 31 + 6 months is Feb 28/29, not Mar 3. */
function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * Pure rule check against a (locked) voucher row. Fail closed: any unrecognised state rejects.
 */
function validateExtensionRequest({ voucher, newExpiry, reason, now = new Date() }) {
  if (!voucher) return fail('NOT_FOUND', 'Voucher not found');

  const status = Number(voucher.status);
  if (STATUS_ERRORS[status]) return fail(...STATUS_ERRORS[status]);
  if (!EXTENDABLE_STATUSES.includes(status)) {
    return fail('NOT_EXTENDABLE', 'Voucher status does not allow extension');
  }

  const balance = Number(voucher.remaining_balance);
  if (!Number.isFinite(balance) || balance <= 0) {
    return fail('NO_BALANCE', 'Voucher has no remaining balance');
  }

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason.length < MIN_REASON_LENGTH || trimmedReason.length > MAX_REASON_LENGTH) {
    return fail('INVALID_REASON', `Reason must be ${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters`);
  }

  const newExpiryDate = parseExpiryDate(newExpiry);
  if (!newExpiryDate) return fail('INVALID_DATE', 'New expiry must be a valid date in YYYY-MM-DD format');

  const used = voucher.first_used_at !== null && voucher.first_used_at !== undefined;
  const clock = used ? 'used' : 'unused';
  const column = used ? 'use_expires_at' : 'expiry_date';
  const oldExpiry = toDateOrNull(voucher[column]);
  // Fail closed: with no governing date on record we cannot prove the extension lengthens anything.
  if (!oldExpiry) return fail('NO_GOVERNING_EXPIRY', 'This voucher has no expiry on record; contact IT');

  const floor = oldExpiry.getTime() > now.getTime() ? oldExpiry : now;
  if (newExpiryDate.getTime() <= floor.getTime()) {
    return fail('NOT_LATER', 'New expiry must be later than both today and the current expiry');
  }

  // Compared at calendar-day granularity: the stored time is always 23:59:59, so the last
  // allowed day is the whole day of (now + 6 months).
  const limit = addMonths(now, MAX_EXTENSION_MONTHS_FROM_NOW);
  limit.setHours(23, 59, 59, 0);
  if (newExpiryDate.getTime() > limit.getTime()) {
    return fail('TOO_FAR', `New expiry cannot be more than ${MAX_EXTENSION_MONTHS_FROM_NOW} months from today`);
  }

  return { ok: true, clock, column, oldExpiry, newExpiryDate, reason: trimmedReason };
}

/**
 * Extend one voucher's governing expiry. Own transaction, row-locked, CAS-guarded.
 * `admin` = { id, username } for the audit row. `conn` optional (tests / callers with a handle).
 */
async function extendVoucherValidity({ voucherId, newExpiry, reason, admin = {}, conn = null }) {
  const ownsConnection = !conn;
  const connection = conn || await getPool().getConnection();
  let began = false;

  try {
    await connection.beginTransaction();
    began = true;

    const [rows] = await connection.query(
      `SELECT id, uid, status, remaining_balance, expiry_date, use_expires_at, first_used_at
         FROM voucherstab
        WHERE id = ?
        FOR UPDATE`,
      [voucherId]
    );
    const voucher = rows && rows[0];

    // The DB clock, not Node's: the voucher expiry sweep compares against MySQL NOW(), so the
    // NOT_LATER floor and TOO_FAR limit must be judged on the same clock.
    const [nowRows] = await connection.query('SELECT NOW() AS db_now');
    const now = toDateOrNull(nowRows && nowRows[0] && nowRows[0].db_now);
    if (!now) throw new VoucherValidityError('CLOCK_UNAVAILABLE', 'Could not read the database clock; retry');

    const check = validateExtensionRequest({ voucher, newExpiry, reason, now });
    if (!check.ok) throw new VoucherValidityError(check.code, check.message);

    const newValue = toMysqlLocal(check.newExpiryDate);
    // CAS: re-assert status, the governing column's old value and the clock selector, so a
    // concurrent change between SELECT and UPDATE can never be silently overwritten.
    const [result] = await connection.query(
      `UPDATE voucherstab
          SET ${check.column} = ?, status = 1
        WHERE id = ?
          AND status IN (1, 2)
          AND ${check.column} <=> ?
          AND (first_used_at IS NULL) = ?`,
      [newValue, voucherId, voucher[check.column] ?? null, check.clock === 'unused' ? 1 : 0]
    );
    if (!result || result.affectedRows !== 1) {
      throw new VoucherValidityError('CONFLICT', 'Voucher changed while extending; reload and retry');
    }

    const oldStatus = Number(voucher.status);
    const oldExpiry = check.oldExpiry ? toMysqlLocal(check.oldExpiry) : null;
    await connection.query(
      `INSERT INTO voucher_validity_extensiontab
         (voucher_id, uid, clock, old_expiry, new_expiry, old_status, new_status, reason, admin_id, admin_username)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        voucherId,
        voucher.uid,
        check.clock,
        oldExpiry,
        newValue,
        oldStatus,
        check.reason,
        admin.id ?? null,
        admin.username ? String(admin.username).slice(0, 120) : null,
      ]
    );

    await connection.commit();
    began = false;

    return {
      voucherId,
      uid: voucher.uid,
      clock: check.clock,
      oldExpiry,
      newExpiry: newValue,
      oldStatus,
      newStatus: 1,
    };
  } catch (error) {
    if (began) {
      try { await connection.rollback(); } catch (_) { /* original error matters more */ }
    }
    throw error;
  } finally {
    if (ownsConnection && typeof connection.release === 'function') connection.release();
  }
}

module.exports = {
  MAX_EXTENSION_MONTHS_FROM_NOW,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  EXTENDABLE_STATUSES,
  VoucherValidityError,
  validateExtensionRequest,
  extendVoucherValidity,
};
