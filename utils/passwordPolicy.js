/**
 * Member password rules, shared by every route that sets a member password.
 *
 * Follows NIST SP 800-63B: length plus a blocklist, not forced symbol/uppercase mixes, which push
 * people to predictable patterns ("Password1!") without adding real strength.
 *
 * MAX_BYTES matters: bcrypt only uses the first 72 BYTES of a password, so anything past that is
 * silently ignored. Rejecting it tells the member the truth instead of storing a weaker password
 * than the one they typed.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MIN_LENGTH = 8;
const MAX_BYTES = 72;

// Most-used passwords plus company-specific guesses. Compared case-insensitively.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '0123456789', '87654321', '11111111', '00000000', '12341234',
  '123123123', '11223344', '12344321', '1q2w3e4r', '1qaz2wsx', 'qwertyui', 'qwerty12', 'qwerty123',
  'qwe12345', 'asdfghjk', 'asdf1234', 'zxcvbnm1', 'abcd1234', 'abc12345', 'aa123456', 'iloveyou',
  'iloveyou1', 'sunshine', 'princess', 'football', 'baseball', 'welcome1', 'welcome123', 'letmein1',
  'changeme', 'admin123', 'administrator', 'superman', 'trustno1', 'dragon123', 'monkey123', 'master123',
  'nogatu', 'nogatu123', 'nogatu1234', 'nogatu2025', 'nogatu2026', 'nogatualliance', 'nogatu@123',
]);

function isDigitRun(value) {
  if (!/^\d+$/.test(value)) return false;
  const digits = value.split('').map(Number);
  const step = digits[1] - digits[0];
  if (Math.abs(step) !== 1) return false;
  return digits.every((d, i) => i === 0 || d - digits[i - 1] === step);
}

/**
 * @param {string} password
 * @param {{ username?: string, email?: string }} [context] identifiers the password must not contain
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateNewPassword(password, context = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Enter a new password.' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    return { ok: false, error: `Use at most ${MAX_BYTES} characters.` };
  }
  if (password !== password.trim()) {
    return { ok: false, error: 'The password cannot start or end with a space.' };
  }

  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password) || isDigitRun(password)) {
    return { ok: false, error: 'This password is too easy to guess. Choose a less common one.' };
  }

  const username = String(context.username || '').trim().toLowerCase();
  if (username.length >= 3 && lower.includes(username)) {
    return { ok: false, error: 'The password cannot contain your username.' };
  }
  const emailName = String(context.email || '').trim().toLowerCase().split('@')[0];
  if (emailName.length >= 3 && lower.includes(emailName)) {
    return { ok: false, error: 'The password cannot contain your email address.' };
  }

  return { ok: true };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * True when candidate is the password already stored. Handles every format memberstab can hold:
 * bcrypt (current), and the PHP-era plaintext / MD5 / SHA-1 values that login still accepts and
 * upgrades on first use.
 */
async function matchesStoredPassword(candidate, storedPassword) {
  const stored = String(storedPassword || '');
  if (!stored || typeof candidate !== 'string') return false;
  if (stored.startsWith('$2')) return bcrypt.compare(candidate, stored);
  if (/^[a-f0-9]{32}$/i.test(stored)
    && safeEqual(crypto.createHash('md5').update(candidate).digest('hex'), stored.toLowerCase())) return true;
  if (/^[a-f0-9]{40}$/i.test(stored)
    && safeEqual(crypto.createHash('sha1').update(candidate).digest('hex'), stored.toLowerCase())) return true;
  return safeEqual(candidate, stored.trim());
}

const SAME_AS_CURRENT_ERROR = 'Your new password must be different from your current password.';

module.exports = {
  MIN_LENGTH,
  MAX_BYTES,
  validateNewPassword,
  matchesStoredPassword,
  SAME_AS_CURRENT_ERROR,
};
