const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeProductReferralRows,
  buildProductSummary,
  buildPackageSummary,
  formatPackageClaimRow,
} = require('../../services/income/hifiveBonus');

test('product Hi-Five counts five distinct direct referrals as one qualified set', () => {
  const { qualifyingReferralsByKey, rawPurchasesByKey, contributorsByKey } = summarizeProductReferralRows([
    { producttype: 100, referralUid: 11, cnt: 1, username: 'dr1', firstname: 'Direct', lastname: 'One', lastTransdate: '2026-05-01 10:00:00' },
    { producttype: 100, referralUid: 12, cnt: 1, username: 'dr2', firstname: 'Direct', lastname: 'Two', lastTransdate: '2026-05-01 11:00:00' },
    { producttype: 100, referralUid: 13, cnt: 1, username: 'dr3', firstname: 'Direct', lastname: 'Three', lastTransdate: '2026-05-01 12:00:00' },
    { producttype: 100, referralUid: 14, cnt: 1, username: 'dr4', firstname: 'Direct', lastname: 'Four', lastTransdate: '2026-05-01 13:00:00' },
    { producttype: 100, referralUid: 15, cnt: 1, username: 'dr5', firstname: 'Direct', lastname: 'Five', lastTransdate: '2026-05-01 14:00:00' },
  ]);

  assert.equal(qualifyingReferralsByKey.bl, 5);
  assert.equal(rawPurchasesByKey.bl, 5);
  assert.equal(contributorsByKey.bl.length, 5);

  const result = buildProductSummary({
    qualifyingReferralsByKey,
    rawPurchasesByKey,
    claimedByKey: { bl: 0 },
    maintenancePoints: 220,
    contributorsByKey,
  });

  const barley = result.products.find((item) => item.key === 'bl');
  assert.equal(barley.qualifyingDirectReferrals, 5);
  assert.equal(barley.directReferralPurchases, 5);
  assert.equal(barley.qualifiedSets, 1);
  assert.equal(barley.availableClaims, 1);
});

test('product Hi-Five does not let one direct referral qualify multiple same-product slots alone', () => {
  const { qualifyingReferralsByKey, rawPurchasesByKey, contributorsByKey } = summarizeProductReferralRows([
    { producttype: 100, referralUid: 11, cnt: 5, username: 'dr1', firstname: 'Direct', lastname: 'One', lastTransdate: '2026-05-01 10:00:00' },
  ]);

  assert.equal(qualifyingReferralsByKey.bl, 1);
  assert.equal(rawPurchasesByKey.bl, 5);

  const result = buildProductSummary({
    qualifyingReferralsByKey,
    rawPurchasesByKey,
    claimedByKey: { bl: 0 },
    maintenancePoints: 220,
    contributorsByKey,
  });

  const barley = result.products.find((item) => item.key === 'bl');
  assert.equal(barley.qualifyingDirectReferrals, 1);
  assert.equal(barley.directReferralPurchases, 5);
  assert.equal(barley.qualifiedSets, 0);
  assert.equal(barley.remainingToNextSet, 4);
});

test('product Hi-Five summary blocks claims until 200 maintenance points are met', () => {
  const result = buildProductSummary({
    qualifyingReferralsByKey: { bl: 10, gl: 4 },
    rawPurchasesByKey: { bl: 10, gl: 4 },
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
    qualifyingReferralsByKey: { bl: 11, cmm: 5 },
    rawPurchasesByKey: { bl: 11, cmm: 5 },
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
