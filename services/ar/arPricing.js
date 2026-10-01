/**
 * AR pricing and numbering — pure functions, no database access.
 *
 * Every money figure is computed in integer centavos and only converted to pesos on the way out,
 * so a long receipt cannot drift by a centavo through float rounding.
 *
 * Mode rules come from PROPOSAL_0023's restriction table and the 2026-10-01 decisions:
 *   - Stockist peso discounts apply to PACKAGES only and never stack with member pricing.
 *   - Only package / cash-member / cash-stockist ARs generate codes.
 */

const MODES = Object.freeze({
  package: {
    label: 'Packages', kind: 'package', priceField: 'member_price',
    generatesCodes: true, requiresMember: true, stockistDiscount: true,
  },
  cash_member: {
    label: 'Cash - member price', kind: 'product', priceField: 'member_price',
    generatesCodes: true, requiresMember: true,
  },
  cash_stockist: {
    label: 'Cash - stockist price', kind: 'product', priceField: 'stockist_price',
    generatesCodes: true, requiresMember: true, requiresStockist: true,
  },
  cash_srp: {
    label: 'Cash - SRP', kind: 'product', priceField: 'srp',
    generatesCodes: false, requiresMember: false,
  },
  voucher: {
    label: 'Voucher', kind: 'product', priceField: 'member_price',
    generatesCodes: false, requiresMember: true, voucherOnly: true,
  },
});

const PAYMENT_METHODS = Object.freeze(['cash', 'gcash', 'bdo', 'psbank', 'other_bank', 'voucher']);
const STOCKIST_TYPES = Object.freeze({ 2: 'Mobile', 3: 'City', 4: 'Provincial' });
const MAX_QTY_PER_LINE = 500; // the code generator's per-batch cap
// One approval mints every code while holding the global code-generation lock, which every other
// Generate Codes caller waits on for only 10s. Bounding the whole AR keeps that lock short.
const MAX_CODES_PER_AR = 500;

const isPackageType = (pt) => [10, 20, 30, 40, 50, 60].includes(pt);
const isProductType = (pt) => Number.isInteger(pt) && pt >= 100 && pt <= 109;

function arError(message, code = 'AR_INVALID_REQUEST') {
  return Object.assign(new Error(message), { code });
}

function toCentavos(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

const toPesos = (centavos) => centavos / 100;

/**
 * Prices a receipt from server-side data only. Client-sent prices are never read.
 *
 * @param {object} args
 * @param {string} args.mode
 * @param {Array<{producttype:number, qty:number}>} args.items
 * @param {Map<number, object>} args.priceList  producttype -> ar_price_listtab row
 * @param {Map<string, number>} args.discounts  `${stockistType}:${producttype}` -> peso discount
 * @param {number|null} args.stockistType       2/3/4, or null for a non-stockist buyer
 */
function priceReceipt({ mode, items, priceList, discounts, stockistType = null }) {
  const rule = MODES[mode];
  if (!rule) throw arError(`Unknown AR mode: ${mode}`);
  if (!Array.isArray(items) || items.length === 0) throw arError('An AR needs at least one item');

  // Merge repeated lines for the same product so one product is one line on the receipt.
  const merged = new Map();
  for (const raw of items) {
    const pt = Number(raw?.producttype);
    const qty = Number(raw?.qty);
    if (!Number.isInteger(pt)) throw arError('Each item needs a valid product');
    if (!Number.isInteger(qty) || qty < 1) throw arError('Quantity must be a whole number of at least 1');
    merged.set(pt, (merged.get(pt) || 0) + qty);
  }

  const applyStockistDiscount = rule.stockistDiscount && Object.hasOwn(STOCKIST_TYPES, String(stockistType));
  const lines = [];
  let subtotal = 0;
  let discountTotal = 0;

  for (const [pt, qty] of merged) {
    if (rule.kind === 'package' && !isPackageType(pt)) throw arError(`${pt} is not a package; this AR is for packages`);
    if (rule.kind === 'product' && !isProductType(pt)) throw arError(`${pt} is not a product; this AR is for products`);
    if (qty > MAX_QTY_PER_LINE) throw arError(`Quantity per item is limited to ${MAX_QTY_PER_LINE}`);

    const row = priceList.get(pt);
    if (!row || !Number(row.active)) throw arError(`Item ${pt} is not on the active price list`, 'AR_PRICE_MISSING');
    const unit = toCentavos(row[rule.priceField]);
    // A zero or missing price means the list is incomplete; refusing beats selling for free.
    if (!Number.isInteger(unit) || unit <= 0) {
      throw arError(`${row.item_name} has no ${rule.priceField.replace('_', ' ')} set`, 'AR_PRICE_MISSING');
    }

    let discountEach = 0;
    if (applyStockistDiscount) {
      discountEach = toCentavos(discounts.get(`${stockistType}:${pt}`) || 0);
      if (!Number.isInteger(discountEach) || discountEach < 0) discountEach = 0;
      discountEach = Math.min(discountEach, unit); // never below zero
    }

    const lineTotal = (unit - discountEach) * qty;
    subtotal += unit * qty;
    discountTotal += discountEach * qty;
    lines.push({
      producttype: pt,
      description: row.item_name,
      qty,
      unit_price: toPesos(unit),
      discount_each: toPesos(discountEach),
      line_total: toPesos(lineTotal),
      generates_codes: rule.generatesCodes ? 1 : 0,
    });
  }

  if (rule.generatesCodes) {
    const codes = lines.reduce((sum, line) => sum + line.qty, 0);
    if (codes > MAX_CODES_PER_AR) {
      throw arError(`One AR can release at most ${MAX_CODES_PER_AR} codes. Split this sale into more ARs.`);
    }
  }

  lines.sort((a, b) => a.producttype - b.producttype);
  return {
    lines,
    subtotal: toPesos(subtotal),
    discount_total: toPesos(discountTotal),
    total: toPesos(subtotal - discountTotal),
    generatesCodes: rule.generatesCodes,
  };
}

/** Numeric-only AR number: 4-digit year + 6-digit (or longer) global sequence, e.g. 2026001236. */
function formatArNo(year, seq) {
  const y = Number(year);
  const n = Number(seq);
  if (!Number.isInteger(y) || y < 2000 || y > 2999) throw arError('Invalid AR year');
  if (!Number.isInteger(n) || n < 1) throw arError('Invalid AR sequence');
  return `${y}${String(n).padStart(6, '0')}`;
}

const isValidArNo = (value) => typeof value === 'string' && /^\d{4,20}$/.test(value);

/** YYYY-MM-DD that names a real calendar day (rejects 2026-02-31, which Date would roll forward). */
function isRealIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Current calendar year in Manila, independent of the server's clock zone. */
function manilaYear(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).getUTCFullYear();
}

function validatePayment(mode, paymentMethod) {
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw arError(`Unknown payment method: ${paymentMethod}`);
  const voucherOnly = Boolean(MODES[mode]?.voucherOnly);
  if (voucherOnly && paymentMethod !== 'voucher') throw arError('A voucher AR must be paid by voucher');
  if (!voucherOnly && paymentMethod === 'voucher') throw arError('Only a voucher AR can be paid by voucher');
}

module.exports = {
  MODES,
  PAYMENT_METHODS,
  STOCKIST_TYPES,
  MAX_QTY_PER_LINE,
  MAX_CODES_PER_AR,
  isPackageType,
  isProductType,
  priceReceipt,
  formatArNo,
  isValidArNo,
  isRealIsoDate,
  manilaYear,
  validatePayment,
  toCentavos,
  arError,
};
