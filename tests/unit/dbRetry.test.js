'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { withDeadlockRetry, isRetryableDeadlockError } = require('../../utils/dbRetry');

function deadlockError(overrides = {}) {
  const err = new Error('Deadlock found when trying to get lock');
  err.code = 'ER_LOCK_DEADLOCK';
  err.errno = 1213;
  return Object.assign(err, overrides);
}

function lockWaitTimeoutError(overrides = {}) {
  const err = new Error('Lock wait timeout exceeded');
  err.code = 'ER_LOCK_WAIT_TIMEOUT';
  err.errno = 1205;
  return Object.assign(err, overrides);
}

test('isRetryableDeadlockError matches deadlock (1213) and lock-wait-timeout (1205)', () => {
  assert.strictEqual(isRetryableDeadlockError(deadlockError()), true);
  assert.strictEqual(isRetryableDeadlockError(lockWaitTimeoutError()), true);
  assert.strictEqual(isRetryableDeadlockError(new Error('unrelated')), false);
  assert.strictEqual(isRetryableDeadlockError(null), false);
});

test('retries on ER_LOCK_DEADLOCK (1213) and eventually succeeds', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls === 1) throw deadlockError();
    return 'ok';
  }, { attempts: 3, label: 'test-1213' });

  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
});

test('retries on ER_LOCK_WAIT_TIMEOUT (1205) and eventually succeeds', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls === 1) throw lockWaitTimeoutError();
    return 'ok';
  }, { attempts: 3, label: 'test-1205' });

  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
});

test('does NOT retry on an unrelated error — rethrows immediately, unwrapped', async () => {
  let calls = 0;
  const originalError = new Error('some unrelated failure');
  originalError.code = 'ER_SOME_OTHER_THING';

  const start = Date.now();
  await assert.rejects(
    () => withDeadlockRetry(async () => {
      calls += 1;
      throw originalError;
    }, { attempts: 3 }),
    (err) => err === originalError
  );
  const elapsedMs = Date.now() - start;

  assert.strictEqual(calls, 1, 'must not retry a non-deadlock error');
  assert.ok(elapsedMs < 30, `must not sleep before rethrowing an unrelated error (took ${elapsedMs}ms)`);
});

test('gives up after the configured attempts and rethrows the ORIGINAL error', async () => {
  let calls = 0;
  const originalError = deadlockError();

  await assert.rejects(
    () => withDeadlockRetry(async () => {
      calls += 1;
      throw originalError;
    }, { attempts: 2, label: 'test-exhaust' }),
    (err) => err === originalError
  );

  assert.strictEqual(calls, 2, 'must call fn exactly `attempts` times, not more');
});

test('succeeds on a later attempt (fails twice, succeeds on the third)', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls < 3) throw deadlockError();
    return 'recovered';
  }, { attempts: 3, label: 'test-later-attempt' });

  assert.strictEqual(result, 'recovered');
  assert.strictEqual(calls, 3);
});

test('matches on errno when code is absent', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('deadlock, no code property');
      err.errno = 1213; // code intentionally absent
      throw err;
    }
    return 'ok-by-errno';
  }, { attempts: 3, label: 'test-errno-only' });

  assert.strictEqual(result, 'ok-by-errno');
  assert.strictEqual(calls, 2);
});

test('a synchronously-throwing fn is caught the same as a rejected promise', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(() => {
    calls += 1;
    if (calls === 1) throw deadlockError(); // sync throw, not a rejected Promise
    return 'sync-recovered';
  }, { attempts: 2 });

  assert.strictEqual(result, 'sync-recovered');
  assert.strictEqual(calls, 2);
});

test('attempts=1 runs fn exactly once with no retry', async () => {
  let calls = 0;
  const originalError = deadlockError();

  await assert.rejects(
    () => withDeadlockRetry(async () => {
      calls += 1;
      throw originalError;
    }, { attempts: 1 }),
    (err) => err === originalError
  );

  assert.strictEqual(calls, 1);
});
