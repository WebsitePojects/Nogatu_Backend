'use strict';

// Retries a DB operation ONLY on MySQL deadlock / lock-wait-timeout errors
// (errno 1213 / 1205). Everything else rethrows immediately, unwrapped —
// this is NOT a generic retry wrapper and must never be applied to a money
// write (see .claude/rules/money-integrity.md — retrying a money write is
// how you double-pay). Safe for pure recompute-and-upsert work only.

const DEFAULT_ATTEMPTS = 3;
// Base backoff per retry (before jitter): ~50ms, ~150ms, ~400ms.
const BASE_DELAYS_MS = [50, 150, 400];

function isRetryableDeadlockError(err) {
  if (!err) return false;
  const code = err.code;
  const errno = err.errno;
  return (
    code === 'ER_LOCK_DEADLOCK' || errno === 1213 ||
    code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205
  );
}

function backoffDelayMs(attemptIndex) {
  const base = BASE_DELAYS_MS[Math.min(attemptIndex, BASE_DELAYS_MS.length - 1)];
  const jitter = Math.random() * base * 0.5;
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` (a zero-arg function returning a value or a Promise) and retries
 * it ONLY when it fails with a deadlock or lock-wait-timeout error.
 *
 * @param {Function} fn - operation to run/retry. Invoked with no arguments.
 * @param {Object} [options]
 * @param {number} [options.attempts=3] - total attempts (not retries). Must
 *   be a positive integer; any other value falls back to the default.
 * @param {string} [options.label] - included in the console.warn on retry.
 * @returns {Promise<*>} whatever `fn` resolves to.
 */
async function withDeadlockRetry(fn, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : DEFAULT_ATTEMPTS;
  const label = options.label || 'withDeadlockRetry';

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableDeadlockError(err) || attempt >= attempts) {
        throw err;
      }
      const delayMs = backoffDelayMs(attempt - 1);
      console.warn(
        `[${label}] deadlock/lock-wait retry attempt ${attempt}/${attempts} ` +
        `after ${Math.round(delayMs)}ms (${err.code || err.errno})`
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }
  // Unreachable (the loop above always returns or throws), kept as a safe fallback.
  throw lastError;
}

module.exports = { withDeadlockRetry, isRetryableDeadlockError };
