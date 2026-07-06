'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Requiring the script must NOT connect to a database: settle_income_sweep.js only runs main()
// when `require.main === module` (i.e. executed directly), and every DB-touching require
// (./env, ../config/database, the engine) is lazy-required INSIDE main(). Pulling in the module
// here must therefore be side-effect-free — if that guard ever regresses, this require() call
// itself would hang/throw trying to open a real MySQL connection with no .env file present.
const {
  DEFAULTS,
  ABORT_THRESHOLD,
  INCOME_FIELDS,
  parseSweepArgs,
  shouldAbort,
  diffCredited,
  formatHelp,
  newStats,
} = require('../../scripts/settle_income_sweep.js');

test('parseSweepArgs: defaults with no args (dry-run, default thresholds)', () => {
  const parsed = parseSweepArgs([]);
  assert.strictEqual(parsed.help, false);
  assert.strictEqual(parsed.commit, false);
  assert.strictEqual(parsed.batchSize, DEFAULTS.batchSize);
  assert.strictEqual(parsed.sleepMs, DEFAULTS.sleepMs);
  assert.strictEqual(parsed.startUid, DEFAULTS.startUid);
  assert.strictEqual(parsed.maxMembers, DEFAULTS.maxMembers);
  assert.strictEqual(parsed.onlyUids, null);
});

test('parseSweepArgs: --commit flips mode, everything else still defaults', () => {
  const parsed = parseSweepArgs(['--commit']);
  assert.strictEqual(parsed.commit, true);
  assert.strictEqual(parsed.batchSize, DEFAULTS.batchSize);
  assert.strictEqual(parsed.sleepMs, DEFAULTS.sleepMs);
});

test('parseSweepArgs: --help / -h short-circuits independent of other flags', () => {
  assert.strictEqual(parseSweepArgs(['--help']).help, true);
  assert.strictEqual(parseSweepArgs(['-h']).help, true);
  assert.strictEqual(parseSweepArgs(['--commit', '--help']).help, true);
  assert.strictEqual(parseSweepArgs([]).help, false);
});

test('parseSweepArgs: --only-uids parses, trims, dedupes-nothing, drops garbage', () => {
  let parsed = parseSweepArgs(['--only-uids', '155253,1961878, 6475210']);
  assert.deepStrictEqual(parsed.onlyUids, [155253, 1961878, 6475210]);

  // non-numeric / zero / negative entries are dropped, not coerced into a wrong uid
  parsed = parseSweepArgs(['--only-uids', '5,abc,-3,0,10']);
  assert.deepStrictEqual(parsed.onlyUids, [5, 10]);

  // flag absent -> null (full-table pagination mode), NOT an empty array
  assert.strictEqual(parseSweepArgs([]).onlyUids, null);
});

test('parseSweepArgs: --start-uid resume point', () => {
  assert.strictEqual(parseSweepArgs(['--start-uid', '500']).startUid, 500);
  // 0 is a legitimate explicit resume point (== "from the top") and must not fall back
  assert.strictEqual(parseSweepArgs(['--start-uid', '0']).startUid, 0);
  // garbage/negative falls back to the default rather than crashing pagination
  assert.strictEqual(parseSweepArgs(['--start-uid', '-7']).startUid, DEFAULTS.startUid);
  assert.strictEqual(parseSweepArgs(['--start-uid', 'notanumber']).startUid, DEFAULTS.startUid);
});

test('parseSweepArgs: --batch-size / --sleep-ms / --max-members parsing + fallbacks', () => {
  const parsed = parseSweepArgs(['--batch-size', '50', '--sleep-ms', '0', '--max-members', '10']);
  assert.strictEqual(parsed.batchSize, 50);
  assert.strictEqual(parsed.sleepMs, 0); // explicit 0 must be honored (throttle disabled)
  assert.strictEqual(parsed.maxMembers, 10);

  // batch-size must stay positive (0/negative/garbage -> default), sleep-ms/max-members allow 0
  assert.strictEqual(parseSweepArgs(['--batch-size', '0']).batchSize, DEFAULTS.batchSize);
  assert.strictEqual(parseSweepArgs(['--batch-size', '-5']).batchSize, DEFAULTS.batchSize);
  assert.strictEqual(parseSweepArgs(['--sleep-ms', '-1']).sleepMs, DEFAULTS.sleepMs);
  assert.strictEqual(parseSweepArgs(['--max-members', '-1']).maxMembers, DEFAULTS.maxMembers);
});

test('shouldAbort: fires exactly at the 25-consecutive-error threshold, not before', () => {
  assert.strictEqual(shouldAbort(0), false);
  assert.strictEqual(shouldAbort(1), false);
  assert.strictEqual(shouldAbort(ABORT_THRESHOLD - 1), false);
  assert.strictEqual(shouldAbort(ABORT_THRESHOLD), true);
  assert.strictEqual(shouldAbort(ABORT_THRESHOLD + 1), true);
  assert.strictEqual(shouldAbort(undefined), false);
});

test('shouldAbort: a single success resets the counter back below threshold (caller contract)', () => {
  // The script resets stats.consecutiveErrors = 0 on any success; shouldAbort itself is stateless
  // and must treat 0 as "not aborting" even immediately after 24 prior errors.
  assert.strictEqual(shouldAbort(0), false);
});

test('diffCredited: no fields moved -> anyCredited false, empty deltas', () => {
  const before = { ttlincome1: 100, ttlincome2: 200 };
  const after = { ttlincome1: 100, ttlincome2: 200 };
  const { anyCredited, deltas } = diffCredited(before, after);
  assert.strictEqual(anyCredited, false);
  assert.deepStrictEqual(deltas, {});
});

test('diffCredited: only rises are reported (monotonic-only view, never negative deltas)', () => {
  const before = { ttlincome1: 100, ttlincome2: 200, ttlincome3: 50 };
  // ttlincome2 DROPS (should never happen from the engine, but this function is a pure diff and
  // must not misreport a drop as a credit) — ttlincome3 rises.
  const after = { ttlincome1: 100, ttlincome2: 150, ttlincome3: 75 };
  const { anyCredited, deltas } = diffCredited(before, after);
  assert.strictEqual(anyCredited, true);
  assert.deepStrictEqual(deltas, { ttlincome3: 25 });
  assert.strictEqual('ttlincome2' in deltas, false); // drop is never surfaced as a "credit"
});

test('diffCredited: missing before/after rows treated as zero, never throws', () => {
  const { anyCredited, deltas } = diffCredited(undefined, { ttlincome5: 12.5 });
  assert.strictEqual(anyCredited, true);
  assert.deepStrictEqual(deltas, { ttlincome5: 12.5 });

  const none = diffCredited(undefined, undefined);
  assert.strictEqual(none.anyCredited, false);
  assert.deepStrictEqual(none.deltas, {});
});

test('diffCredited: floating point noise below a cent does not register as a credit', () => {
  const before = { ttlincome1: 100.004999 };
  const after = { ttlincome1: 100.005 }; // rounds to the same 2dp value
  const { anyCredited } = diffCredited(before, after);
  assert.strictEqual(anyCredited, false);
});

test('newStats: seeds lastUid from --start-uid and zeroes every income field', () => {
  const stats = newStats(500);
  assert.strictEqual(stats.lastUid, 500);
  assert.strictEqual(stats.scanned, 0);
  assert.strictEqual(stats.credited, 0);
  assert.strictEqual(stats.errors, 0);
  for (const f of INCOME_FIELDS) assert.strictEqual(stats.creditedByType[f], 0);
});

test('formatHelp: documents --commit as the only writing mode and mentions --help', () => {
  const help = formatHelp();
  assert.match(help, /DRY-RUN/);
  assert.match(help, /--commit/);
  assert.match(help, /--only-uids/);
  assert.match(help, /--start-uid/);
  assert.match(help, /--help/);
});
