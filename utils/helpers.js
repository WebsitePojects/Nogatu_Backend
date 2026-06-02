const { MAINTENANCE_PRODUCT_TYPES } = require('../constants/maintenanceProductCatalog');

/**
 * Shared helper functions used across the application
 */

// Account type numeric code to name mapping (mirrors PHP logic exactly)
const ACCOUNT_TYPES = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

const PACKAGE_BINARY_POINTS = {
  10: 1,
  20: 2,
  30: 4,
  40: 10,
  50: 20,
  60: 60,
};

const PACKAGE_BINARY_VALUES = {
  10: 250,
  20: 500,
  30: 1000,
  40: 2500,
  50: 5000,
  60: 15000,
};

// Product type to name mapping
const PRODUCT_TYPES = {
  10: 'Bronze Entry Package',
  20: 'Silver Entry Package',
  30: 'Gold Entry Package',
  40: 'Platinum Entry Package',
  50: 'Garnet Entry Package',
  60: 'Diamond Entry Package',
  ...MAINTENANCE_PRODUCT_TYPES,
};

// Code type prefix mapping
const CODE_PREFIXES = {
  1: 'PD',
  2: 'FS',
  3: 'CD',
};

// Payout option mapping
const PAYOUT_OPTIONS = {
  Pickup: 'Pickup',
  'Bank Deposit': 'Bank Deposit',
  Gcash: 'Gcash',
  'Remittance Center': 'Remittance Center',
  Others: 'Others',
  PSBank: 'PSBank',
};

// Codeid to entry type mapping
const ENTRY_TYPES = {
  1: 'Paid Account',
  2: 'Free Slot',
  3: 'CD Slot',
};

// Sanitize input - mirrors PHP preg_replace('/[^A-Za-z0-9\ ]/', '', $val)
function sanitizeAlphaNum(val) {
  if (!val) return '';
  return String(val).replace(/\s/g, '').replace(/[^A-Za-z0-9]/g, '');
}

// Format number with 2 decimal places (mirrors PHP number_format)
function formatNumber(num, decimals = 2) {
  return Number(num || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Get account type name from numeric code
function getAccountTypeName(code) {
  return ACCOUNT_TYPES[code] || 'Unknown';
}

// Generate -3 seconds offset timestamp (mirrors PHP $newTime = strtotime('-3 seconds'))
function getOffsetTimestamp() {
  const d = new Date(Date.now() - 3000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Get current datetime string in MySQL format
function nowMySQL() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Get date range for current month
function currentMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return {
    start: `${y}-${m}-01`,
    end: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

// Get date range for previous month
function previousMonthRange() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = prev.getFullYear();
  const m = String(prev.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, prev.getMonth() + 1, 0).getDate();
  return {
    start: `${y}-${m}-01`,
    end: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

// Get ISO week number (mirrors PHP date('W'))
function getISOWeek(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

module.exports = {
  ACCOUNT_TYPES,
  PACKAGE_BINARY_POINTS,
  PACKAGE_BINARY_VALUES,
  PRODUCT_TYPES,
  CODE_PREFIXES,
  PAYOUT_OPTIONS,
  ENTRY_TYPES,
  sanitizeAlphaNum,
  formatNumber,
  getAccountTypeName,
  getOffsetTimestamp,
  nowMySQL,
  currentMonthRange,
  previousMonthRange,
  getISOWeek,
};
