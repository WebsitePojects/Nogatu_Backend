/**
 * Activation Code Generation Service
 * 1:1 port of PHP insertactivationcodes-fnc.php
 *
 * Generates activation codes using PseudoCrypt hashing
 * Assigns proper points, prices, and types per product
 */
const { pool } = require('../config/database');
const PseudoCrypt = require('../utils/pseudoCrypt');

// Product configuration - 1:1 from PHP codeInsert()
const PRODUCT_CONFIG = {
  // Account types (10-60)
  10: { name: 'Bronze', directreferral: 250, binarypoints: 250, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 2500 },
  20: { name: 'Silver', directreferral: 500, binarypoints: 500, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 5000 },
  30: { name: 'Gold', directreferral: 1000, binarypoints: 1000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 10000 },
  40: { name: 'Platinum', directreferral: 2500, binarypoints: 2500, unilevelpoints: 0, incentivepoints: 0, profitsharing: 60, productamount: 25000 },
  50: { name: 'Garnet', directreferral: 5000, binarypoints: 5000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 50000 },
  60: { name: 'Diamond', directreferral: 15000, binarypoints: 15000, unilevelpoints: 0, incentivepoints: 0, profitsharing: 0, productamount: 150000 },
  // Product types (100+)
  100: { name: 'Barley', directreferral: 0, binarypoints: 0, unilevelpoints: 50, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  101: { name: 'Glutathione', directreferral: 0, binarypoints: 0, unilevelpoints: 45, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  102: { name: 'Gluta w/ Collagen', directreferral: 0, binarypoints: 0, unilevelpoints: 40, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  103: { name: 'Coffee Mix', directreferral: 0, binarypoints: 0, unilevelpoints: 40, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  104: { name: 'Chocolate Drink', directreferral: 0, binarypoints: 0, unilevelpoints: 45, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  105: { name: 'Mangosteen', directreferral: 0, binarypoints: 0, unilevelpoints: 30, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  106: { name: 'Vitamin Zinc', directreferral: 0, binarypoints: 0, unilevelpoints: 40, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  107: { name: 'Max Coffee', directreferral: 0, binarypoints: 0, unilevelpoints: 100, incentivepoints: 0, profitsharing: 0, productamount: 0 },
  108: { name: 'Black Coffee', directreferral: 0, binarypoints: 0, unilevelpoints: 10, incentivepoints: 0, profitsharing: 0, productamount: 0 },
};

// Code type prefixes
const CODE_PREFIXES = { 1: 'PD', 2: 'FS', 3: 'CD' };

/**
 * Generate activation codes
 * @param {number} noOfCodes - Number of codes to generate
 * @param {number} productType - Product type (10-60 or 100+)
 * @param {number} codeType - Code type (1=PD, 2=FS, 3=CD)
 * @param {number} stockistId - Stockist ID
 * @param {string} adminId - Admin who generated codes
 * @returns {Array} Generated codes
 */
async function generateCodes(noOfCodes, productType, codeType, stockistId, adminId) {
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
    const num = startNum + i;
    let hash = PseudoCrypt.hash(num, 10).toUpperCase();

    // Add prefix based on code type or product type
    let prefix;
    if (productType >= 100) {
      prefix = 'MC';
    } else {
      prefix = CODE_PREFIXES[codeType] || 'PD';
    }

    const code = prefix + hash;

    // Insert into database
    await codeInsert(code, productType, codeType, stockistId, adminId);
    generatedCodes.push(code);
  }

  return generatedCodes;
}

/**
 * Insert a single code into the database
 * Mirrors PHP codeInsert()
 */
async function codeInsert(code, productType, codeType, stockistId, adminId) {
  const config = PRODUCT_CONFIG[productType];
  if (!config) throw new Error(`Unknown product type: ${productType}`);

  await pool.query(
    `INSERT INTO codestab
     (id, code, producttype, productamount, codetype, directreferral,
      binarypoints, unilevelpoints, incentivepoints, profitsharing,
      stockistid, invoiceid, uid, dateused, dategen, releasedate, codestatus, processid)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NOW(), 0, 0, NULL)`,
    [code, productType, config.productamount, codeType,
     config.directreferral, config.binarypoints, config.unilevelpoints,
     config.incentivepoints, config.profitsharing, stockistId]
  );
}

module.exports = { generateCodes, PRODUCT_CONFIG, CODE_PREFIXES };
