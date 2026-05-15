const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const normalized = normalizeEmail(value);
  return normalized.length > 0 && normalized.length <= 180 && EMAIL_REGEX.test(normalized);
}

module.exports = {
  EMAIL_REGEX,
  normalizeEmail,
  isValidEmail,
};
