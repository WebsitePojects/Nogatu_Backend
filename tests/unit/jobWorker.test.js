'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// services/jobWorker.js requires ../config/database and ../utils/cloudinary at
// import time (both need real env/DB config to construct without throwing), so
// we do NOT `require()` the module directly in a unit test. Instead we:
//  (a) re-implement `describeError` verbatim as a pure function and pin its
//      contract with direct assertions, and
//  (b) assert on the SOURCE TEXT of jobWorker.js for the reaper's SQL
//      predicates and the pruning throttle, the same technique already used
//      by tests/unit/rankIncentiveNoWalletCredit.test.js for services/ranking.js.

const ROOT = path.join(__dirname, '..', '..');
const jobWorkerSrc = fs.readFileSync(path.join(ROOT, 'services', 'jobWorker.js'), 'utf8');

// ── Verbatim mirror of services/jobWorker.js `describeError` ──
function describeError(err) {
  if (err instanceof Error) {
    const code = err.code ? ` (code: ${err.code})` : '';
    return `${err.message || err.name || 'Error'}${code}`;
  }
  if (err === null || err === undefined) return String(err);
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ── describeError contract ──
test('describeError: Error with a code includes both message and code', () => {
  const err = new Error('upload rejected');
  err.code = 'ENOTFOUND';
  assert.strictEqual(describeError(err), 'upload rejected (code: ENOTFOUND)');
});

test('describeError: Error without a code omits the suffix', () => {
  const err = new Error('plain failure');
  assert.strictEqual(describeError(err), 'plain failure');
});

test('describeError: Error with empty message falls back to name', () => {
  const err = new Error('');
  assert.strictEqual(describeError(err), 'Error');
});

test('describeError: plain object (Cloudinary-style rejection) is JSON-stringified', () => {
  const rejection = { message: 'Invalid signature', http_code: 401 };
  assert.strictEqual(describeError(rejection), JSON.stringify(rejection));
  // Never the old blank-log bug: this must not be undefined/empty.
  assert.ok(describeError(rejection).length > 0);
});

test('describeError: circular object does not throw and returns a non-empty string', () => {
  const circular = { name: 'orphan' };
  circular.self = circular;
  assert.doesNotThrow(() => describeError(circular));
  const out = describeError(circular);
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('describeError: string is returned as-is', () => {
  assert.strictEqual(describeError('boom'), 'boom');
});

test('describeError: null and undefined are stringified, never throw', () => {
  assert.strictEqual(describeError(null), 'null');
  assert.strictEqual(describeError(undefined), 'undefined');
});

// ── DEFECT 2 regression: no bare `.message` reads remain on caught errors ──
test('no console.error call in jobWorker.js reads err.message/e.message directly', () => {
  const bareMessageReads = jobWorkerSrc.match(/console\.error\([^)]*\.message/g) || [];
  assert.deepStrictEqual(bareMessageReads, [],
    'every console.error must go through describeError(), not a bare .message read');
});

test('every console.error call in jobWorker.js is routed through describeError', () => {
  const errorCalls = jobWorkerSrc.match(/console\.error\([^;]*\)/g) || [];
  assert.ok(errorCalls.length >= 4, 'expected at least 4 console.error sites (reclaim/prune/job-failed/tick/destroy)');
  for (const call of errorCalls) {
    assert.match(call, /describeError\(/, `console.error call does not use describeError: ${call}`);
  }
});

// ── DEFECT 1: reaper predicates ──
test('reclaimStaleLeases targets stale processing rows with a 15-minute window', () => {
  assert.match(jobWorkerSrc, /LEASE_TTL_MINUTES\s*=\s*15/,
    'lease TTL must remain 15 minutes (must comfortably exceed a real sweep runtime)');
  assert.match(jobWorkerSrc,
    /WHERE\s+status\s*=\s*'processing'\s+AND\s+locked_at\s*<\s*NOW\(6\)\s*-\s*INTERVAL\s*\?\s*MINUTE/,
    'reaper WHERE must match status=processing AND a stale locked_at, parameterized');
});

test('reclaimStaleLeases routes to failed when attempts >= MAX_ATTEMPTS, else back to queued', () => {
  assert.match(jobWorkerSrc, /CASE WHEN attempts >= \? THEN 'failed' ELSE 'queued' END/,
    'must branch on attempts >= MAX_ATTEMPTS between failed and queued');
  assert.match(jobWorkerSrc, /available_at = CASE WHEN attempts >= \? THEN available_at ELSE NOW\(6\) END/,
    'reclaimed-to-queued rows must become immediately available (available_at = NOW(6))');
});

test('reclaimStaleLeases is called before leaseOne on every tick', () => {
  const tickStart = jobWorkerSrc.indexOf('async function tick()');
  const tickEnd = jobWorkerSrc.indexOf('\n}', jobWorkerSrc.indexOf('async function tick()'));
  const tickBody = jobWorkerSrc.slice(tickStart, tickEnd);
  const reclaimAt = tickBody.indexOf('reclaimStaleLeases()');
  const leaseAt = tickBody.indexOf('leaseOne()');
  assert.ok(reclaimAt > -1, 'tick() must call reclaimStaleLeases()');
  assert.ok(leaseAt > -1, 'tick() must call leaseOne()');
  assert.ok(reclaimAt < leaseAt, 'reclaimStaleLeases() must run BEFORE leaseOne()');
});

test('reclaimStaleLeases never weakens the leaseOne CAS', () => {
  assert.match(jobWorkerSrc,
    /WHERE id=\? AND status='queued'/,
    "leaseOne's compare-and-swap predicate must remain: WHERE id=? AND status='queued'");
  assert.match(jobWorkerSrc, /affectedRows !== 1/,
    'leaseOne must still fail closed on a lost race');
});

// ── DEFECT 3: pruning ──
test('pruneOldTerminalJobs deletes only terminal rows older than 30 days', () => {
  assert.match(jobWorkerSrc, /PRUNE_RETENTION_DAYS\s*=\s*30/, 'retention must be 30 days');
  assert.match(jobWorkerSrc,
    /WHERE\s+status\s+IN\s*\('done',\s*'failed'\)\s+AND\s+updated_at\s*<\s*DATE_SUB\(NOW\(6\),\s*INTERVAL\s*\?\s*DAY\)/,
    'prune predicate must scope to done/failed and an updated_at cutoff, parameterized');
});

test('pruneOldTerminalJobs is throttled to at most once per hour via a module-level timestamp', () => {
  assert.match(jobWorkerSrc, /PRUNE_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/,
    'prune throttle interval must be one hour');
  assert.match(jobWorkerSrc, /let lastPruneAt = 0;/,
    'must track last prune time in a module-level variable, not a second timer');
  assert.match(jobWorkerSrc, /if \(now - lastPruneAt < PRUNE_INTERVAL_MS\) return;/,
    'must early-return when called again inside the same hour window');
});

// ── Public surface untouched ──
test('public exports still include startWorker and enqueue unchanged', () => {
  assert.match(jobWorkerSrc, /module\.exports = \{ startWorker, enqueue, describeError \};/);
});

test('POLL_MS, MAX_ATTEMPTS and the backoff formula are unchanged', () => {
  assert.match(jobWorkerSrc, /const POLL_MS = 15000;/);
  assert.match(jobWorkerSrc, /const MAX_ATTEMPTS = 5;/);
  assert.match(jobWorkerSrc, /Math\.min\(3600, 2 \*\* attempts \* 30\)/);
});
