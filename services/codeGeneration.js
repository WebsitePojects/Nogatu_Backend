/**
 * Activation Code Generation Service
 * 1:1 port of PHP insertactivationcodes-fnc.php
 *
 * Generates activation codes using PseudoCrypt hashing
 * Assigns proper points, prices, and types per product
 */
const { pool } = require('../config/database');
const PseudoCrypt = require('../utils/pseudoCrypt');
const crypto = require('crypto');
const { createProcessKey } = require('../utils/security');
const { appendActivationCodeUsage } = require('./registrationAudit');
const { MAINTENANCE_PRODUCT_CONFIG } = require('../constants/maintenanceProductCatalog');

// Product configuration - 1:1 from PHP codeInsert()
const PRODUCT_CONFIG = {
  // Account types (10-60)
  // Keep persisted binarypoints aligned with the live PHP/DB shape:
  // peso-equivalent pairing values are stored in codestab/usertab/upgradetab,
  // while human-readable BP counts live in helpers/package metadata.
  10: { name: 'Bronze', directreferral: 250, binarypoints: 250, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 2500 },
  20: { name: 'Silver', directreferral: 500, binarypoints: 500, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 5000 },
  30: { name: 'Gold', directreferral: 1000, binarypoints: 1000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 10000 },
  40: { name: 'Platinum', directreferral: 2500, binarypoints: 2500, unilevelpoints: 0, incentivepoints: 0, profitsharing: 60, productamount: 25000 },
  50: { name: 'Garnet', directreferral: 5000, binarypoints: 5000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 50000 },
  60: { name: 'Diamond', directreferral: 15000, binarypoints: 15000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 150000 },
  // Product types (100+)
  ...MAINTENANCE_PRODUCT_CONFIG,
};

// Code type prefixes
const CODE_PREFIXES = { 1: 'PD', 2: 'FS', 3: 'CD' };

const CODE_TYPE_PAID = 1;
const CODE_TYPE_FREE_SLOT = 2;
const CODE_TYPE_CD = 3;
const VALID_CODE_TYPES = [CODE_TYPE_PAID, CODE_TYPE_FREE_SLOT, CODE_TYPE_CD];

/**
 * CD Slot is restricted to GOLD (30) and PLATINUM (40) — management decision
 * 2026-08-08. A CD code creates a standing 25% encashment-deduction obligation
 * sized to the package (`cdamount`), so issuing one against a tier or a
 * maintenance product outside this list creates an obligation the comp plan does
 * not define, on a member who can then never clear it.
 *
 * Enforced server-side because the Generate Codes form is a convenience: the
 * route accepts a JSON body, so hiding the option in the UI restricts nothing.
 */
const CD_ELIGIBLE_PRODUCT_TYPES = [30, 40];

function isCdEligibleProductType(productType) {
  return CD_ELIGIBLE_PRODUCT_TYPES.includes(Number(productType));
}

/**
 * Boundary validation for a code-generation request. FAILS CLOSED: an unknown
 * product type or code type is rejected, never defaulted (money-integrity rule 3).
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateCodeGenerationRequest(productType, codeType) {
  const type = Number(productType);
  const kind = Number(codeType);

  if (!Number.isInteger(type) || !PRODUCT_CONFIG[type]) {
    return { valid: false, error: `Unknown product type: ${productType}` };
  }

  if (!Number.isInteger(kind) || !VALID_CODE_TYPES.includes(kind)) {
    return { valid: false, error: `Unknown code type: ${codeType}` };
  }

  if (kind === CODE_TYPE_CD && !isCdEligibleProductType(type)) {
    const allowed = CD_ELIGIBLE_PRODUCT_TYPES
      .map((t) => PRODUCT_CONFIG[t]?.name || t)
      .join(' and ');
    return {
      valid: false,
      error: `CD Slot is only available for ${allowed}. `
        + `"${PRODUCT_CONFIG[type].name}" cannot be issued as a CD code.`,
    };
  }

  return { valid: true };
}
const PACKAGE_ABBREVIATIONS = {
  10: 'BR',
  20: 'SI',
  30: 'GO',
  40: 'PL',
  50: 'GA',
  60: 'DI',
};

function buildEntryCodePrefix(productType, codeType) {
  if (Number(productType) >= 100) {
    return 'MC';
  }

  const typePrefix = CODE_PREFIXES[Number(codeType)] || 'PD';
  const packagePrefix = PACKAGE_ABBREVIATIONS[Number(productType)] || 'PK';
  return `${typePrefix}${packagePrefix}`;
}

function buildGeneratedCode(num, productType, codeType) {
  const prefix = buildEntryCodePrefix(productType, codeType);
  const hashLength = Number(productType) >= 100 ? 10 : 8;
  const hash = PseudoCrypt.hash(num, hashLength).toUpperCase();
  return prefix + hash;
}

/**
 * Generate activation codes
 * @param {number} noOfCodes - Number of codes to generate
 * @param {number} productType - Product type (10-60 or 100+)
 * @param {number} codeType - Code type (1=PD, 2=FS, 3=CD)
 * @param {number} stockistId - Stockist ID
 * @param {string} adminId - Admin who generated codes
 * @returns {Array} Generated codes
 */
function normalizeAdminContext(adminContext) {
  if (adminContext && typeof adminContext === 'object' && !Array.isArray(adminContext)) {
    return {
      adminUsername: adminContext.adminUsername || adminContext.adminId || null,
      actorAdminId: Number(adminContext.actorAdminId || adminContext.adminNumericId || 0) || null,
    };
  }

  return {
    adminUsername: adminContext ? String(adminContext) : null,
    actorAdminId: null,
  };
}

function normalizeRequiredText(value, field, maxLength = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    const error = new Error(`${field} is required and must be a non-empty string of at most ${maxLength} characters`);
    error.code = 'INVALID_CODE_GENERATION_REQUEST';
    throw error;
  }
  return value.trim();
}

function buildGenerationRequestHash({ noOfCodes, productType, codeType, stockistId, arNumber }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ noOfCodes, productType, codeType, stockistId, arNumber }))
    .digest('hex');
}

const CODE_GENERATION_LOCK = 'nogatu_code_generation';

function invalidRequest(message, code = 'INVALID_CODE_GENERATION_REQUEST') {
  return Object.assign(new Error(message), { code });
}

/**
 * Validates and normalises a generation request. Shared by generateCodes() and the AR release so
 * both enforce the same CD restriction, count cap and key format.
 */
function prepareGenerationRequest(noOfCodes, productType, codeType, stockistId, adminContext, options = {}) {
  // Re-validated here, not only at the route, so no future caller can bypass the
  // CD restriction by reaching the generator directly.
  const validation = validateCodeGenerationRequest(productType, codeType);
  if (!validation.valid) throw invalidRequest(validation.error);

  const count = Number(noOfCodes);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw invalidRequest('Number of codes must be a positive integer no greater than 500');
  }
  const arNumber = normalizeRequiredText(options.arNumber, 'AR number');
  const idempotencyKey = normalizeRequiredText(options.idempotencyKey, 'Idempotency-Key', 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
    throw invalidRequest('Idempotency-Key must contain 8-64 letters, numbers, hyphens, or underscores');
  }

  const normalizedAdmin = normalizeAdminContext(adminContext);
  return {
    count,
    productType: Number(productType),
    codeType: Number(codeType),
    stockistId: Number(stockistId),
    arNumber,
    idempotencyKey,
    normalizedAdmin,
    // Admin generation always has an actor scope; use zero when an older session
    // omitted the numeric id so the durable unique key cannot become NULL-scoped.
    actorAdminId: normalizedAdmin.actorAdminId || 0,
    requestHash: buildGenerationRequestHash({
      noOfCodes: count, productType: Number(productType), codeType: Number(codeType),
      stockistId: Number(stockistId), arNumber,
    }),
  };
}

async function acquireCodeGenerationLock(conn) {
  const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [CODE_GENERATION_LOCK]);
  return Number(lockRows[0]?.lockState || 0) === 1;
}

async function releaseCodeGenerationLock(conn) {
  await conn.query('SELECT RELEASE_LOCK(?)', [CODE_GENERATION_LOCK]);
}

/**
 * Core allocation. MUST run inside an open transaction on `conn` while the caller holds the
 * generation lock (MAX(id)-based numbering is only collision-free under that lock).
 *
 * Returns { replayed: true, codes } when this idempotency key already completed (codes only, no
 * row ids), or { replayed: false, codes, rows } with the freshly inserted { id, code } rows.
 */
async function allocateCodesInTransaction(conn, request) {
  const {
    count, productType, codeType, stockistId, arNumber, idempotencyKey,
    normalizedAdmin, actorAdminId, requestHash,
  } = request;

  const replayOrReject = (row) => {
    if (row?.request_hash !== requestHash) {
      throw invalidRequest('This idempotency key was already used for a different generation request', 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    }
    if (row?.status === 'completed') return { replayed: true, codes: JSON.parse(row.codes_json || '[]') };
    throw invalidRequest('This generation request is already being processed', 'GENERATION_IN_PROGRESS');
  };

  const [existingRows] = await conn.query(
    'SELECT * FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
    [actorAdminId, idempotencyKey]
  );
  if (existingRows.length) return replayOrReject(existingRows[0]);

  try {
    await conn.query(
      `INSERT INTO code_generation_batchtab
        (idempotency_key, actor_admin_id, actor_admin, ar_number, request_hash, no_of_codes, product_type, code_type, stockist_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idempotencyKey, actorAdminId, normalizedAdmin.adminUsername, arNumber, requestHash, count, productType, codeType, stockistId]
    );
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [duplicateRows] = await conn.query(
      'SELECT request_hash, status, codes_json FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
      [actorAdminId, idempotencyKey]
    );
    return replayOrReject(duplicateRows[0]);
  }

  const [[batch]] = await conn.query(
    'SELECT id FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
    [actorAdminId, idempotencyKey]
  );
  const [maxRows] = await conn.query('SELECT MAX(id) AS maxId FROM codestab');
  const baseOffset = productType >= 1 && productType <= 99 ? 6100000 : 710000;
  let nextNum = Number(maxRows[0]?.maxId || 0) + baseOffset;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    let code = buildGeneratedCode(nextNum, productType, codeType);
    while (true) {
      const [existingCode] = await conn.query('SELECT id FROM codestab WHERE code = ? LIMIT 1', [code]);
      if (!existingCode.length) break;
      nextNum += 1;
      code = buildGeneratedCode(nextNum, productType, codeType);
    }
    const codeId = await codeInsert(conn, code, productType, codeType, stockistId, normalizedAdmin);
    await conn.query(
      'INSERT INTO code_generation_batch_codetab (batch_id, code_id, code, ar_number) VALUES (?, ?, ?, ?)',
      [batch.id, codeId, code, arNumber]
    );
    rows.push({ id: codeId, code });
    nextNum += 1;
  }
  const codes = rows.map((r) => r.code);
  await conn.query(
    `UPDATE code_generation_batchtab SET status = 'completed', codes_json = ?, completed_at = NOW(6) WHERE id = ? LIMIT 1`,
    [JSON.stringify(codes), batch.id]
  );
  return { replayed: false, codes, rows };
}

async function generateCodes(noOfCodes, productType, codeType, stockistId, adminContext, options = {}) {
  const request = prepareGenerationRequest(noOfCodes, productType, codeType, stockistId, adminContext, options);
  const conn = await pool.getConnection();
  let txStarted = false;
  let lockAcquired = false;
  try {
    lockAcquired = await acquireCodeGenerationLock(conn);
    if (!lockAcquired) throw new Error('Unable to allocate codes right now. Please retry.');
    await conn.beginTransaction();
    txStarted = true;
    const result = await allocateCodesInTransaction(conn, request);
    if (result.replayed) {
      await conn.rollback();
    } else {
      await conn.commit();
    }
    txStarted = false;
    return result.codes;
  } catch (error) {
    if (txStarted) await conn.rollback();
    throw error;
  } finally {
    let reusable = true;
    if (lockAcquired) {
      try {
        await releaseCodeGenerationLock(conn);
      } catch (releaseError) {
        reusable = false;
        conn.destroy();
      }
    }
    if (reusable) conn.release();
  }
}

/**
 * Insert a single code into the database
 * Mirrors PHP codeInsert()
 */
async function codeInsert(conn, code, productType, codeType, stockistId, adminContext) {
  const config = PRODUCT_CONFIG[productType];
  if (!config) throw new Error(`Unknown product type: ${productType}`);
  const { adminUsername, actorAdminId } = normalizeAdminContext(adminContext);

  const [result] = await conn.query(
      `INSERT INTO codestab
       (id, code, producttype, productamount, codetype, directreferral,
        binarypoints, unilevelpoints, incentivepoints, profitsharing,
        stockistid, invoiceid, uid, dateused, dategen, releasedate, codestatus, processid)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NOW(), 0, 0, ?)`,
      [code, productType, config.productamount, codeType,
       config.directreferral, config.binarypoints, config.unilevelpoints,
       config.incentivepoints, config.profitsharing, stockistId, adminUsername]
    );

    await appendActivationCodeUsage(conn, {
      code,
      codeRowId: result.insertId || null,
      eventType: 'generated',
      actorAdminId,
      notes: {
        productType: Number(productType),
        codeType: Number(codeType),
        stockistId: Number(stockistId) || null,
        generatedByUsername: adminUsername || null,
      },
      processKey: createProcessKey(['code-generated', code, result.insertId || code, adminUsername || 'system']),
    });

  return result.insertId || null;
}

module.exports = {
  generateCodes,
  prepareGenerationRequest,
  allocateCodesInTransaction,
  acquireCodeGenerationLock,
  releaseCodeGenerationLock,
  validateCodeGenerationRequest,
  isCdEligibleProductType,
  CD_ELIGIBLE_PRODUCT_TYPES,
  VALID_CODE_TYPES,
  PRODUCT_CONFIG,
  CODE_PREFIXES,
  PACKAGE_ABBREVIATIONS,
  buildEntryCodePrefix,
  buildGeneratedCode,
};
