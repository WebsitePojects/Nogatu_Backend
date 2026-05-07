const crypto = require('crypto');

function stablePart(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value, Object.keys(value).sort());
  return String(value);
}

function createProcessKey(parts) {
  const input = Array.isArray(parts) ? parts : [parts];
  return crypto
    .createHash('sha256')
    .update(input.map(stablePart).join(':'))
    .digest('hex');
}

function createPublicId() {
  return crypto.randomUUID();
}

function createReferralSlug(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function normalizeReferralSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function maskSensitiveValue(value, visible = 4) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${'*'.repeat(text.length - visible)}${text.slice(-visible)}`;
}

function requestId(req) {
  const fromHeader = req?.headers?.['x-request-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim().slice(0, 80);
  }
  return crypto.randomUUID();
}

module.exports = {
  createProcessKey,
  createPublicId,
  createReferralSlug,
  normalizeReferralSlug,
  maskSensitiveValue,
  requestId,
};
