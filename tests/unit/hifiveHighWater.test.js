'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPackageSummary,
  packageEntitlement,
  recordPackageHighWater,
  getPackageHighWater,
} = require('../../services/income/hifiveBonus');
const { replayTimeline } = require('../../services/income/hifiveHighWaterReplay');

const REWARDS = { bronze: 2500, silver: 5000, gold: 10000, platinum: 25000, garnet: 50000, diamond: 150000 };

// Reming001 (Upgrade Stranding Audit 2026-09-25): 20 Bronze directs = 4 sets paid, then four
// upgraded to Gold and a fifth joined at Gold. Current Bronze 16, Gold 5; Bronze high-water 20.
const REMING_NOW = { bronze: 16, gold: 5 };

test('a dissolved set stays earned: Reming001 is entitled to PHP 20,000, not 17,500', () => {
  assert.equal(packageEntitlement(REMING_NOW, {}, REWARDS), 17500, 'baseline: the old engine view');
  assert.equal(packageEntitlement(REMING_NOW, { bronze: 20 }, REWARDS), 20000);
});

test('high-water never double counts: new directs refill the tier before a new set is earned', () => {
  // Bronze back up to 21 after dropping to 16: still only the 4 sets from the original 20.
  assert.equal(packageEntitlement({ bronze: 21 }, { bronze: 20 }, REWARDS), 4 * 2500);
  assert.equal(packageEntitlement({ bronze: 25 }, { bronze: 20 }, REWARDS), 5 * 2500);
});

test('without stored high-water the entitlement is exactly the old engine (no payout moves on deploy)', () => {
  const counts = { bronze: 13, silver: 5, diamond: 10 };
  const old = Math.floor(13 / 5) * 2500 + 1 * 5000 + 2 * 150000;
  assert.equal(packageEntitlement(counts, {}, REWARDS), old);
  assert.equal(packageEntitlement(counts, { bronze: 13, silver: 5, diamond: 10 }, REWARDS), old);
});

test('package summary counts sets from high-water and the next set needs the current count to pass it', () => {
  const summary = buildPackageSummary({
    directReferralPackages: { bronze: 16, gold: 5 },
    claimedPackageSets: {},
    rewardAmounts: REWARDS,
    highWaterPackages: { bronze: 20 },
  });
  const bronze = summary.packages.find((p) => p.key === 'bronze');
  assert.equal(bronze.directReferralCount, 16, 'shows directs held today');
  assert.equal(bronze.qualifiedSets, 4);
  assert.equal(bronze.highWaterCount, 20);
  assert.equal(bronze.remainingToNextSet, 9, 'needs 25 Bronze for set 5');
  // No high-water: the original rule (5 - remainder, 5 at an exact multiple).
  const plain = buildPackageSummary({ directReferralPackages: { silver: 10, gold: 3 }, claimedPackageSets: {}, rewardAmounts: REWARDS });
  assert.equal(plain.packages.find((p) => p.key === 'silver').remainingToNextSet, 5);
  assert.equal(plain.packages.find((p) => p.key === 'gold').remainingToNextSet, 2);
});

function fakeDb(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return handler(sql, params); } };
}

test('recording high-water only ever raises it, and tags the source only when it rises', async () => {
  const db = fakeDb(() => [{ affectedRows: 2 }]);
  await recordPackageHighWater(77, { bronze: 16, gold: 5, silver: 0 }, { db, source: 'observed' });
  assert.equal(db.calls.length, 1);
  const { sql, params } = db.calls[0];
  assert.match(sql, /high_water = GREATEST\(high_water, VALUES\(high_water\)\)/);
  // source must be assigned BEFORE high_water: later assignments see the updated value.
  assert.ok(sql.indexOf('source = IF(VALUES(high_water) > high_water') < sql.indexOf('high_water = GREATEST'));
  assert.deepEqual(params[0], [[77, 10, 16, 'observed'], [77, 30, 5, 'observed']], 'zero tiers are not written');
});

test('nothing to record writes nothing; a missing V050 table is tolerated on read and write', async () => {
  const empty = fakeDb(() => [{ affectedRows: 0 }]);
  assert.equal(await recordPackageHighWater(77, { bronze: 0 }, { db: empty }), 0);
  assert.equal(empty.calls.length, 0);

  const missing = fakeDb(() => { throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }); });
  assert.equal(await recordPackageHighWater(77, { bronze: 5 }, { db: missing }), 0);
  assert.equal((await getPackageHighWater(77, missing)).bronze, 0);

  const broken = fakeDb(() => { throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }); });
  await assert.rejects(() => recordPackageHighWater(77, { bronze: 5 }, { db: broken }), /deadlock/);
});

test('replay: a set must exist at one moment; joining after others left is not a set', () => {
  const d = (uid, accttype, datereg) => ({ uid, accttype, datereg });
  const ups = (rows) => new Map(rows.map(([uid, tier, transdate]) => [uid, [{ tier, transdate }]]));
  // Three Bronze, all upgrade to Gold, then two more Bronze join: never five Bronze at once.
  const directs = [d(1, 10, '2026-01-01'), d(2, 10, '2026-01-02'), d(3, 10, '2026-01-03'), d(4, 10, '2026-03-01'), d(5, 10, '2026-03-02')];
  const out = replayTimeline(directs, ups([[1, 30, '2026-02-01'], [2, 30, '2026-02-01'], [3, 30, '2026-02-01']]));
  assert.equal(out.highWater.bronze, 3);
  assert.deepEqual([out.current.bronze, out.current.gold], [2, 3]);
  // Five Bronze held together, then two upgrade: Bronze high-water 5.
  const held = replayTimeline(directs.map((x) => ({ ...x, datereg: '2026-01-01' })), ups([[1, 30, '2026-02-01'], [2, 30, '2026-02-01']]));
  assert.equal(held.highWater.bronze, 5);
  assert.equal(held.current.bronze, 3);
});
