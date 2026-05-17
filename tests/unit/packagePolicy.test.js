const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPackagePolicy,
  getPackagePairingDepthLimit,
  getPackagePairingWeeklyCap,
  getPackageSealingPoint,
  getPackagePairingMonthlyCap,
  getPackageLifetimeIncomeCeiling,
  getPackageDefaultSalesMatchReserveCeiling,
  listPackagePolicies,
} = require('../../services/packagePolicy');

test('package policy list preserves the six published package tiers in order', () => {
  assert.deepEqual(
    listPackagePolicies().map((pkg) => pkg.packageType),
    [10, 20, 30, 40, 50, 60]
  );
});

test('bronze package keeps the PPT safety net and depth-limited sales match rules', () => {
  const bronze = getPackagePolicy(10);

  assert.equal(bronze.packageLabel, 'Bronze');
  assert.equal(bronze.binaryPoints, 1);
  assert.equal(getPackagePairingDepthLimit(10), 3);
  assert.equal(getPackagePairingWeeklyCap(10), 10000);
  assert.equal(getPackageSealingPoint(10), 40000);
  assert.equal(getPackageLifetimeIncomeCeiling(10), 40000);
  assert.equal(getPackageDefaultSalesMatchReserveCeiling(10), 40000);
  assert.equal(bronze.rankingEligible, false);
});

test('gold and above expose monthly pairing caps instead of lifetime sealing points', () => {
  const gold = getPackagePolicy(30);
  const platinum = getPackagePolicy(40);
  const diamond = getPackagePolicy(60);

  assert.equal(gold.rankingMaxLabel, 'Supervisor 3');
  assert.equal(gold.nextUpgradePackageLabel, 'Platinum');
  assert.equal(gold.sealingPoint, 0);
  assert.equal(getPackageLifetimeIncomeCeiling(30), 0);
  assert.equal(getPackagePairingMonthlyCap(30), 160000);
  assert.equal(getPackageDefaultSalesMatchReserveCeiling(30), 160000);

  assert.equal(platinum.rankingMaxLabel, 'Manager 3');
  assert.equal(platinum.nextUpgradePackageLabel, 'Garnet');
  assert.equal(platinum.sealingPoint, 0);
  assert.equal(getPackagePairingMonthlyCap(40), 320000);
  assert.equal(getPackageDefaultSalesMatchReserveCeiling(40), 320000);

  assert.equal(diamond.nextUpgradePackageLabel, null);
  assert.equal(diamond.sealingPoint, 0);
  assert.equal(diamond.binaryPoints, 60);
});
