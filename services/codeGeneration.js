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

async function generateCodes(noOfCodes, productType, codeType, stockistId, adminContext, options = {}) {
  // Re-validated here, not only at the route, so no future caller can bypass the
  // CD restriction by reaching the generator directly.
  const validation = validateCodeGenerationRequest(productType, codeType);
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = 'INVALID_CODE_GENERATION_REQUEST';
    throw error;
  }

  const count = Number(noOfCodes);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    const error = new Error('Number of codes must be a positive integer no greater than 500');
    error.code = 'INVALID_CODE_GENERATION_REQUEST';
    throw error;
  }
  const arNumber = normalizeRequiredText(options.arNumber, 'AR number');
  const idempotencyKey = normalizeRequiredText(options.idempotencyKey, 'Idempotency-Key', 64);
  const keyPattern = /^[A-Za-z0-9_-]{8,64}$/;
  if (!keyPattern.test(idempotencyKey)) {
    const error = new Error('Idempotency-Key must contain 8-64 letters, numbers, hyphens, or underscores');
    error.code = 'INVALID_CODE_GENERATION_REQUEST';
    throw error;
  }

  const normalizedAdmin = normalizeAdminContext(adminContext);
  const requestHash = buildGenerationRequestHash({ noOfCodes: count, productType: Number(productType), codeType: Number(codeType), stockistId: Number(stockistId), arNumber });
  const conn = await pool.getConnection();
  let txStarted = false;
  let lockAcquired = false;
  // Admin generation always has an actor scope; use zero when an older session
  // omitted the numeric id so the durable unique key cannot become NULL-scoped.
  const actorAdminId = normalizedAdmin.actorAdminId || 0;
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', ['nogatu_code_generation']);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) throw new Error('Unable to allocate codes right now. Please retry.');
    await conn.beginTransaction();
    txStarted = true;
    const [existingRows] = await conn.query(
      'SELECT * FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
      [actorAdminId, idempotencyKey]
    );
    if (existingRows.length) {
      const existing = existingRows[0];
      if (existing.request_hash !== requestHash) {
        const error = new Error('This idempotency key was already used for a different generation request');
        error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        throw error;
      }
      if (existing.status === 'completed') {
        await conn.rollback();
        txStarted = false;
        return JSON.parse(existing.codes_json || '[]');
      }
      const error = new Error('This generation request is already being processed');
      error.code = 'GENERATION_IN_PROGRESS';
      throw error;
    }
    try {
      await conn.query(
        `INSERT INTO code_generation_batchtab
          (idempotency_key, actor_admin_id, actor_admin, ar_number, request_hash, no_of_codes, product_type, code_type, stockist_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [idempotencyKey, actorAdminId, normalizedAdmin.adminUsername, arNumber, requestHash, count, Number(productType), Number(codeType), Number(stockistId)]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const [duplicateRows] = await conn.query(
          'SELECT request_hash, status, codes_json FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
          [actorAdminId, idempotencyKey]
        );
        const duplicate = duplicateRows[0];
        if (duplicate?.request_hash !== requestHash) {
          throw Object.assign(new Error('This idempotency key was already used for a different generation request'), { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
        }
        if (duplicate?.status === 'completed') {
          await conn.rollback();
          txStarted = false;
          return JSON.parse(duplicate.codes_json || '[]');
        }
        throw Object.assign(new Error('This generation request is already being processed'), { code: 'GENERATION_IN_PROGRESS' });
      }
      throw error;
    }
    const [[batch]] = await conn.query(
      'SELECT id FROM code_generation_batchtab WHERE actor_admin_id <=> ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
      [actorAdminId, idempotencyKey]
    );
    const [maxRows] = await conn.query('SELECT MAX(id) AS maxId FROM codestab');
    const baseOffset = Number(productType) >= 1 && Number(productType) <= 99 ? 6100000 : 710000;
    let nextNum = Number(maxRows[0]?.maxId || 0) + baseOffset;
    const generatedCodes = [];
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
      generatedCodes.push(code);
      nextNum += 1;
    }
    await conn.query(
      `UPDATE code_generation_batchtab SET status = 'completed', codes_json = ?, completed_at = NOW(6) WHERE id = ? LIMIT 1`,
      [JSON.stringify(generatedCodes), batch.id]
    );
    await conn.commit();
    txStarted = false;
    return generatedCodes;
  } catch (error) {
    if (txStarted) await conn.rollback();
    throw error;
  } finally {
    let reusable = true;
    if (lockAcquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', ['nogatu_code_generation']);
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
