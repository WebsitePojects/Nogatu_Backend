const TIN_REGEX = /^[0-9-]+$/;
const MIN_TIN_DIGITS = 9;
const MAX_TIN_DIGITS = 12;
const TIN_GROUP_SIZE = 3;
// 000-000-000-000 (12 digits) is always accepted as the default "no TIN" placeholder.

function extractTinDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(0, MAX_TIN_DIGITS);
}

function formatTin(value) {
  const digits = extractTinDigits(value);
  if (!digits) return '';
  return digits.match(new RegExp(`.{1,${TIN_GROUP_SIZE}}`, 'g')).join('-');
}

function normalizeTin(value) {
  return formatTin(value);
}

function resolveTin(payload = {}) {
  return normalizeTin(payload.tin || payload.tinno || '');
}

function isValidTin(value) {
  const tin = normalizeTin(value);
  const digitCount = extractTinDigits(tin).length;
  return digitCount >= MIN_TIN_DIGITS && digitCount <= MAX_TIN_DIGITS && TIN_REGEX.test(tin);
}

function isZeroTin(value) {
  const digits = extractTinDigits(value);
  return digits.length === MAX_TIN_DIGITS && /^0+$/.test(digits);
}

module.exports = {
  extractTinDigits,
  formatTin,
  normalizeTin,
  resolveTin,
  isValidTin,
  isZeroTin,
  MIN_TIN_DIGITS,
  MAX_TIN_DIGITS,
};
