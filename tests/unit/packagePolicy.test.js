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

test('bronze package: weekly+monthly SMB caps only; PPT/depth/sealing removed; ranking-eligible', () => {
  const bronze = getPackagePolicy(10);

  assert.equal(bronze.packageLabel, 'Bronze');
  assert.equal(bronze.binaryPoints, 1);
  // Caps gate Sales Match Bonus (pairing) only — weekly + monthly, no lifetime ceiling.
  assert.equal(getPackagePairingWeeklyCap(10), 10000);
  assert.equal(getPackagePairingMonthlyCap(10), 40000);
  // PPT safety net + pairing depth limit + lifetime sealing/ceiling were removed (2026-06-21).
  assert.equal(getPackagePairingDepthLimit(10), null);
  assert.equal(getPackageSealingPoint(10), 0);
  assert.equal(getPackageLifetimeIncomeCeiling(10), 0);
  // All packages now rank up to AMBASSADOR (package rank gate lifted).
  assert.equal(bronze.rankingEligible, true);
  assert.equal(bronze.rankingMaxLabel, 'AMBASSADOR');
});

test('gold and above expose monthly pairing caps instead of lifetime sealing points', () => {
  const gold = getPackagePolicy(30);
  const platinum = getPackagePolicy(40);
  const diamond = getPackagePolicy(60);

  assert.equal(gold.rankingMaxLabel, 'AMBASSADOR');
  assert.equal(gold.nextUpgradePackageLabel, 'Platinum');
  assert.equal(gold.sealingPoint, 0);
  assert.equal(getPackageLifetimeIncomeCeiling(30), 0);
  assert.equal(getPackagePairingMonthlyCap(30), 160000);
  assert.equal(getPackageDefaultSalesMatchReserveCeiling(30), 160000);

  assert.equal(platinum.rankingMaxLabel, 'AMBASSADOR');
  assert.equal(platinum.nextUpgradePackageLabel, 'Garnet');
  assert.equal(platinum.sealingPoint, 0);
  assert.equal(getPackagePairingMonthlyCap(40), 320000);
  assert.equal(getPackageDefaultSalesMatchReserveCeiling(40), 320000);

  assert.equal(diamond.nextUpgradePackageLabel, null);
  assert.equal(diamond.sealingPoint, 0);
  assert.equal(diamond.binaryPoints, 60);
});
