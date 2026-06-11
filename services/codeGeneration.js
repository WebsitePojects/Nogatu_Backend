/**
 * Activation Code Generation Service
 * 1:1 port of PHP insertactivationcodes-fnc.php
 *
 * Generates activation codes using PseudoCrypt hashing
 * Assigns proper points, prices, and types per product
 */
const { pool } = require('../config/database');
const PseudoCrypt = require('../utils/pseudoCrypt');
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

async function generateCodes(noOfCodes, productType, codeType, stockistId, adminContext) {
  const normalizedAdmin = normalizeAdminContext(adminContext);
  // Get current max ID from codestab
  const [maxRows] = await pool.query('SELECT MAX(id) as maxId FROM codestab');
  const currentMax = Number(maxRows[0]?.maxId || 0);

  // Calculate starting number (mirrors PHP logic)
  let baseOffset;
  if (productType >= 1 && productType <= 99) {
    baseOffset = 6100000;
  } else {
    baseOffset = 710000;
  }

  const startNum = currentMax + baseOffset;
  const generatedCodes = [];

  for (let i = 0; i < noOfCodes; i++) {
    let num = startNum + i;
    let code = buildGeneratedCode(num, productType, codeType);
    let duplicateGuard = 0;

    while (duplicateGuard < 20) {
      const [existingRows] = await pool.query(
        'SELECT id FROM codestab WHERE code = ? LIMIT 1',
        [code]
      );
      if (existingRows.length === 0) {
        break;
      }
      duplicateGuard += 1;
      num += 1;
      code = buildGeneratedCode(num, productType, codeType);
    }

    await codeInsert(code, productType, codeType, stockistId, normalizedAdmin);
    generatedCodes.push(code);
  }

  return generatedCodes;
}

/**
 * Insert a single code into the database
 * Mirrors PHP codeInsert()
 */
async function codeInsert(code, productType, codeType, stockistId, adminContext) {
  const config = PRODUCT_CONFIG[productType];
  if (!config) throw new Error(`Unknown product type: ${productType}`);
  const { adminUsername, actorAdminId } = normalizeAdminContext(adminContext);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

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

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  generateCodes,
  PRODUCT_CONFIG,
  CODE_PREFIXES,
  PACKAGE_ABBREVIATIONS,
  buildEntryCodePrefix,
  buildGeneratedCode,
};
