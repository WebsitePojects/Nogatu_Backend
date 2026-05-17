/**
 * Registration Service
 * 1:1 port of PHP registration-fnc.php + new-account-registration.php logic
 *
 * Handles validation, UID generation, and member/user insertion
 */
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { sanitizeAlphaNum, getOffsetTimestamp } = require('../utils/helpers');
const { normalizeTin, isValidTin } = require('../utils/tin');
const { issueVoucher } = require('./voucher');
const { createPublicId, createReferralSlug, createProcessKey } = require('../utils/security');
const { normalizeEmail, isValidEmail } = require('../utils/email');

let memberTinColumnReady = false;

async function ensureMemberTinColumn() {
  if (memberTinColumnReady) return;

  const [columns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'tin'");
  if (columns.length === 0) {
    await pool.query('ALTER TABLE memberstab ADD COLUMN tin VARCHAR(30) DEFAULT NULL');
  }

  const [emailColumns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'email'");
  if (emailColumns.length === 0) {
    await pool.query('ALTER TABLE memberstab ADD COLUMN email VARCHAR(180) DEFAULT NULL');
  } else if (!String(emailColumns[0].Type || '').toLowerCase().includes('180')) {
    await pool.query('ALTER TABLE memberstab MODIFY COLUMN email VARCHAR(180) DEFAULT NULL');
  }

  memberTinColumnReady = true;
}

/**
 * Check if activation code is valid and available
 * Mirrors PHP chk_code()
 */
async function checkCode(code) {
  const [rows] = await pool.query(
    `SELECT * FROM codestab WHERE code = ? AND producttype >= 1
     AND producttype <= 100 AND codestatus = 1`,
    [code]
  );
  return rows.length >= 1 ? rows[0] : null;
}

/**
 * Check if activation code exists and is released (for AJAX validation)
 */
async function validateCode(code) {
  const [rows] = await pool.query(
    "SELECT * FROM codestab WHERE code = ? AND codestatus = '1'",
    [code.trim()]
  );
  return rows.length === 1;
}

/**
 * Check if username already exists
 * Mirrors PHP chk_username()
 */
async function checkUsername(username) {
  const sanitized = sanitizeAlphaNum(username);
  if (!sanitized) return true; // Empty = taken

  const [rows] = await pool.query(
    'SELECT uid, username FROM memberstab WHERE username = ?',
    [sanitized]
  );
  return rows.length >= 1; // true = exists
}

/**
 * Get account UID from username
 * Mirrors PHP get_accountid()
 */
async function getAccountId(username) {
  const sanitized = sanitizeAlphaNum(username);
  const [rows] = await pool.query(
    'SELECT uid FROM memberstab WHERE username = ?',
    [sanitized]
  );
  return rows.length >= 1 ? rows[0].uid : 0;
}

/**
 * Get username from UID
 * Mirrors PHP get_username() / getSponsor()
 */
async function getUsernameByUid(uid) {
  const [rows] = await pool.query(
    'SELECT username FROM memberstab WHERE uid = ?',
    [uid]
  );
  return rows.length >= 1 ? rows[0].username : '0';
}

/**
 * Check placement availability
 * Mirrors PHP get_placement()
 * Returns 1 if position is occupied, 0 if available
 */
async function checkPlacement(placementId, position) {
  const [rows] = await pool.query(
    'SELECT uid FROM usertab WHERE refid = ? AND position = ?',
    [placementId, position]
  );
  return rows.length >= 1 ? 1 : 0;
}

/**
 * Get available position for placement
 * Mirrors PHP getPosition()
 * Returns: 1 (left available), 2 (right available), 0 (both full)
 */
async function getAvailablePosition(placementId) {
  const [rows] = await pool.query(
    'SELECT refid, position FROM usertab WHERE refid = ?',
    [placementId]
  );

  if (rows.length === 0) return 1;
  if (rows.length === 1) {
    return rows[0].position === 1 ? 2 : 1;
  }
  return 0; // Both positions taken
}

/**
 * Check total child count under a placement
 * Mirrors PHP registration-fnc.php placementid check
 */
async function checkPlacementSlots(placementId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) as total FROM usertab WHERE refid = ?',
    [placementId]
  );
  return Number(rows[0].total) >= 2; // true = both slots taken
}

/**
 * Check if account name already exists (exact match)
 * Mirrors PHP get_accountname()
 */
async function checkAccountName(firstname, lastname, middlename) {
  const fn = sanitizeAlphaNum(firstname);
  const ln = sanitizeAlphaNum(lastname);
  const mn = sanitizeAlphaNum(middlename);

  const [rows] = await pool.query(
    `SELECT uid, firstname, lastname, middlename FROM memberstab
     WHERE firstname = ? AND lastname = ? AND middlename = ?`,
    [fn, ln, mn]
  );

  return {
    count: rows.length,
    uid: rows.length > 0 ? rows[0].uid : 0,
  };
}

/**
 * Normalize name for duplicate detection (DOC2 §4.4)
 * "Juan Delgado" and "Delgado Juan" both → "delgadojuan"
 */
function normalizeName(first, last) {
  const parts = [first, last]
    .map(s => (s || '').toLowerCase().trim())
    .filter(s => s.length > 0)
    .sort();
  return parts.join('');
}

/**
 * Check for one-name duplicates using normalized name comparison
 * Returns matching records if any found
 */
async function checkDuplicateName(firstname, lastname) {
  const normalized = normalizeName(firstname, lastname);
  if (!normalized) return { isDuplicate: false, matches: [] };

  const [rows] = await pool.query(
    'SELECT uid, firstname, lastname FROM memberstab'
  );

  const matches = rows.filter(row => {
    const existing = normalizeName(row.firstname, row.lastname);
    return existing === normalized;
  });

  return {
    isDuplicate: matches.length > 0,
    matches: matches.map(m => ({
      uid: m.uid,
      name: `${m.firstname} ${m.lastname}`,
    })),
  };
}

/**
 * Get available codes for a sponsor by package type (DOC2 §4.5)
 * Used for auto-fill code dropdown on registration form
 */
async function getAvailableCodes(sponsorUid, packageType) {
  const [rows] = await pool.query(
    `SELECT code, producttype FROM codestab
     WHERE uid = ? AND codestatus = 1 AND producttype = ?
     ORDER BY id ASC`,
    [sponsorUid, packageType]
  );
  return rows;
}

/**
 * Generate unique UID (7-digit random)
 * Mirrors PHP get_UID()
 */
async function generateUID() {
  let attempts = 0;
  while (attempts < 100) {
    const uid = Math.floor(Math.random() * 9999999) + 1;
    const padded = String(uid).padStart(7, '0');
    const numUid = Number(padded);

    const [rows] = await pool.query(
      'SELECT uid FROM usertab WHERE uid = ?',
      [numUid]
    );

    if (rows.length === 0) return numUid;
    attempts++;
  }
  throw new Error('Could not generate unique UID');
}

/**
 * Get next sequential ID
 * Mirrors PHP get_countid()
 */
async function getNextCountId() {
  const [rows] = await pool.query(
    'SELECT id FROM usertab ORDER BY id DESC LIMIT 1'
  );
  return (rows.length > 0 ? Number(rows[0].id) : 0) + 1;
}

function deriveRegistrationCdState(codeData) {
  if (Number(codeData?.codetype) === 3) {
    return {
      cdAmount: Number(codeData?.productamount || 0),
      cdTotal: 0,
      cdStatus: 1,
    };
  }

  return {
    cdAmount: 0,
    cdTotal: 0,
    cdStatus: 0,
  };
}

async function consumeActivationCodeForRegistration(conn, { activationCode, sponsorUid }) {
  const [codeRows] = await conn.query(
    `SELECT * FROM codestab WHERE code = ? AND uid = ? AND codestatus = 1
     AND producttype >= 1 AND producttype <= 100
     LIMIT 1`,
    [activationCode, sponsorUid]
  );
  if (codeRows.length === 0) throw new Error('Invalid or used activation code');
  const codeData = codeRows[0];

  const [updateResult] = await conn.query(
    `UPDATE codestab
        SET dateused = NOW(), codestatus = 2
      WHERE code = ? AND uid = ? AND codestatus = 1
      LIMIT 1`,
    [activationCode, sponsorUid]
  );

  if (Number(updateResult?.affectedRows || 0) !== 1) {
    throw new Error('Invalid or used activation code');
  }

  return codeData;
}

/**
 * Register a new member account
 * Mirrors the full registration flow from new-account-registration.php
 */
async function registerMember({
  activationCode, sponsorUid, placementUid, username, password,
  firstname, lastname, middlename, tin, email, position
}) {
  await ensureMemberTinColumn();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const normalizedTin = String(tin || '').trim();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedTin || normalizedTin.length < 9 || normalizedTin.length > 30 || !/^[0-9-]+$/.test(normalizedTin)) {
      throw new Error('Invalid TIN format');
    }
    if (!isValidEmail(normalizedEmail)) {
      throw new Error('A valid email address is required.');
    }

    // 1. Validate activation code
    const codeData = await consumeActivationCodeForRegistration(conn, {
      activationCode,
      sponsorUid,
    });

    // 2. Check username uniqueness
    const [existingUser] = await conn.query(
      'SELECT uid FROM memberstab WHERE username = ?',
      [sanitizeAlphaNum(username)]
    );
    if (existingUser.length > 0) throw new Error('Username already taken');

    const [existingEmail] = await conn.query(
      'SELECT uid FROM memberstab WHERE email = ? LIMIT 1',
      [normalizedEmail]
    );
    if (existingEmail.length > 0) throw new Error('Email address is already being used by another account');

    // 3. Check placement availability
    const [placementCheck] = await conn.query(
      'SELECT uid FROM usertab WHERE refid = ? AND position = ?',
      [placementUid, position]
    );
    if (placementCheck.length > 0) throw new Error('Placement position already taken');

    // 4. Generate UID and count ID
    const newUid = await generateUID();
    const newCountId = await getNextCountId();

    // 5. Calculate CD amount/total if codetype == 3
    const { cdAmount, cdTotal, cdStatus } = deriveRegistrationCdState(codeData);

    const now = getOffsetTimestamp();

    // 6. Insert into usertab
    await conn.query(
      `INSERT INTO usertab (id, uid, refid, drefid, mainid, stockistid,
       accttype, currentaccttype, packageid, codeid, activationcode,
       datereg, activedate, position, binarypoints, directreferral,
       incentivepoints, cdamount, cdtotal, cdstatus, profitsharing, status, encodeid)
       VALUES (?, ?, ?, ?, ?, ?,
       ?, ?, NULL, ?, ?,
       ?, NULL, ?, ?, ?,
       ?, ?, ?, ?, ?, 1, ?)`,
      [newCountId, newUid, placementUid, sponsorUid, newUid, codeData.stockistid,
       codeData.producttype, codeData.producttype, codeData.codetype, activationCode,
       now, position, codeData.binarypoints, codeData.directreferral,
       codeData.incentivepoints, cdAmount, cdTotal, cdStatus, codeData.profitsharing, sponsorUid]
    );

    // 7. Insert into memberstab (hash password with bcrypt)
    const hashedPassword = await bcrypt.hash(password, 12);
    await conn.query(
      `INSERT INTO memberstab (id, uid, username, password, firstname, lastname, middlename, tin, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newCountId, newUid, sanitizeAlphaNum(username), hashedPassword, firstname, lastname, middlename, normalizedTin, normalizedEmail.slice(0, 180)]
    );

    await conn.query(
      'UPDATE usertab SET public_uid = ?, referral_slug = ? WHERE uid = ? LIMIT 1',
      [createPublicId(), createReferralSlug(8), newUid]
    ).catch(() => {});

    await conn.query(
      `INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
       VALUES (?, ?, 0, 'self')`,
      [newUid, newUid]
    ).catch(() => {});

    await conn.query(
      `INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
       SELECT ancestor_uid, ?, depth + 1,
              CASE WHEN ancestor_uid = ? THEN ? ELSE leg END
       FROM binary_tree_closuretab
       WHERE descendant_uid = ?`,
      [newUid, placementUid, Number(position) === 1 ? 'left' : 'right', placementUid]
    ).catch(() => {});

    await conn.query(
      `INSERT INTO binary_point_eventstab
       (event_uid, source_member_uid, owner_uid, parent_uid, leg, event_type,
        package_type, point_value, reference_key, event_ts)
       VALUES (?, ?, ?, ?, ?, 'registration', ?, ?, ?, CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE event_uid = event_uid`,
      [
        createPublicId(),
        newUid,
        sponsorUid,
        placementUid,
        Number(position) === 1 ? 'left' : 'right',
        String(codeData.producttype || ''),
        Number(codeData.binarypoints || 0),
        createProcessKey(['binary_point', 'registration', activationCode, newUid]),
      ]
    ).catch(() => {});

    // 9. Issue voucher for new member (DOC2 §4.1)
    try {
      await issueVoucher(conn, newUid, codeData.producttype);
    } catch (voucherErr) {
      // Voucher issuance is non-critical — log but don't block registration
      // Table may not exist yet if migrations haven't run
      console.warn('[Registration] Voucher issuance skipped:', voucherErr.message);
    }

    await conn.commit();

    return {
      success: true,
      uid: newUid,
      username: sanitizeAlphaNum(username),
      placementUid,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  checkCode,
  validateCode,
  checkUsername,
  getAccountId,
  getUsernameByUid,
  checkPlacement,
  getAvailablePosition,
  checkPlacementSlots,
  checkAccountName,
  checkDuplicateName,
  getAvailableCodes,
  normalizeName,
  generateUID,
  getNextCountId,
  deriveRegistrationCdState,
  consumeActivationCodeForRegistration,
  registerMember,
  ensureMemberTinColumn,
};
