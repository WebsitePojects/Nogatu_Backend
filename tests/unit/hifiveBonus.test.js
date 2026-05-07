const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProductSummary,
  buildPackageSummary,
  formatPackageClaimRow,
} = require('../../services/income/hifiveBonus');

test('product Hi-Five summary blocks claims until 200 maintenance points are met', () => {
  const result = buildProductSummary({
    purchasesByKey: { bl: 10, gl: 4 },
    claimedByKey: { bl: 1, gl: 0 },
    maintenancePoints: 150,
  });

  const barley = result.products.find((item) => item.key === 'bl');
  const glutathione = result.products.find((item) => item.key === 'gl');

  assert.equal(result.eligible, false);
  assert.equal(result.pointsNeeded, 50);
  assert.equal(barley.qualifiedSets, 2);
  assert.equal(barley.availableClaims, 0);
  assert.equal(barley.blockedClaims, 1);
  assert.equal(glutathione.remainingToNextSet, 1);
  assert.equal(result.products.find((item) => item.key === 'cd').remainingToNextSet, 5);
});

test('product Hi-Five summary exposes available claims when maintenance is satisfied', () => {
  const result = buildProductSummary({
    purchasesByKey: { bl: 11, cmm: 5 },
    claimedByKey: { bl: 1, cmm: 0 },
    maintenancePoints: 220,
  });

  const barley = result.products.find((item) => item.key === 'bl');
  const maxCoffee = result.products.find((item) => item.key === 'cmm');

  assert.equal(result.eligible, true);
  assert.equal(result.totalAvailableClaims, 2);
  assert.equal(barley.availableClaims, 1);
  assert.equal(maxCoffee.availableClaims, 1);
});

test('package Hi-Five summary converts direct referral groups into cash claims by tier', () => {
  const result = buildPackageSummary({
    directReferralPackages: { bronze: 4, silver: 10, diamond: 5 },
    claimedPackageSets: { bronze: 0, silver: 1, diamond: 0 },
    rewardAmounts: { bronze: 2500, silver: 5000, diamond: 150000 },
  });

  const bronze = result.packages.find((item) => item.key === 'bronze');
  const silver = result.packages.find((item) => item.key === 'silver');
  const diamond = result.packages.find((item) => item.key === 'diamond');

  assert.equal(bronze.availableClaims, 0);
  assert.equal(bronze.remainingToNextSet, 1);
  assert.equal(silver.qualifiedSets, 2);
  assert.equal(silver.availableClaims, 1);
  assert.equal(silver.availableCashAmount, 5000);
  assert.equal(diamond.availableCashAmount, 150000);
  assert.equal(result.packages.find((item) => item.key === 'garnet').remainingToNextSet, 5);
  assert.equal(result.totalAvailableCashAmount, 155000);
});

test('package claim rows format payout totals and labels for admin review', () => {
  const formatted = formatPackageClaimRow({
    id: 15,
    qualification_uid: 'claim-15',
    member_uid: 99,
    username: 'sampleuser',
    firstname: 'Sample',
    lastname: 'Member',
    package_or_product: 'silver',
    qualifying_count: 1,
    status: 'pending_review',
    suspicious_flags: null,
    admin_notes: 'Needs approval',
    created_at: '2026-05-07 10:00:00',
    updated_at: '2026-05-07 10:00:00',
  }, {
    silver: 5000,
  });

  assert.equal(formatted.packageName, 'Silver');
  assert.equal(formatted.rewardAmount, 5000);
  assert.equal(formatted.totalPayout, 5000);
  assert.equal(formatted.statusLabel, 'Pending Review');
  assert.equal(formatted.fullname, 'Sample Member');
});
