const TIN_REGEX = /^[0-9-]+$/;

function normalizeTin(value) {
  return String(value || '').trim();
}

function resolveTin(payload = {}) {
  return normalizeTin(payload.tin || payload.tinno || '');
}

function isValidTin(value) {
  const tin = normalizeTin(value);
  return tin.length >= 9 && tin.length <= 30 && TIN_REGEX.test(tin);
}

module.exports = {
  normalizeTin,
  resolveTin,
  isValidTin,
};