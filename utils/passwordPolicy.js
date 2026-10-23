/**
 * Member password rules, shared by every route that sets a member password.
 *
 * Deliberately minimal (account owner's decision, 2026-10-23): members may choose any password,
 * including predictable ones such as 12345678. Only rules that protect the member from a broken
 * or misleading result are enforced:
 *   - at least MIN_LENGTH characters
 *   - at most MAX_BYTES bytes: bcrypt only uses the first 72 BYTES and silently ignores the rest,
 *     so a longer password would be stored weaker than the one the member typed
 *   - no leading or trailing spaces, which members paste by accident and then cannot log in with
 *   - not the same as the current password (matchesStoredPassword, checked by the route)
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MIN_LENGTH = 8;
const MAX_BYTES = 72;

/**
 * @param {string} password
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateNewPassword(password) {
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
