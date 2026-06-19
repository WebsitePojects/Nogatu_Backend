const { getAccountTypeName } = require('../utils/helpers');

const PACKAGE_POLICY_MAP = {
  10: {
    packageType: 10,
    packageLabel: 'Bronze',
    packageAmount: 2500,
    directReferralBonus: 250,
    binaryValue: 250,
    binaryPoints: 1,
    pairingWeeklyCap: 10000,
    pairingMonthlyCap: 40000,
    lifetimeIncomeCeiling: 40000,
    sealingPoint: 40000,
    pairingDepthLimit: null,
    unilevelReach: 3,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: 30,
    nextUpgradePackageLabel: 'Gold',
    salesMatchNote: 'Bronze sales match reaches the full binary depth like every package, with a PHP 40,000 lifetime ceiling across all credited income before upgrade is needed.',
  },
  20: {
    packageType: 20,
    packageLabel: 'Silver',
    packageAmount: 5000,
    directReferralBonus: 500,
    binaryValue: 500,
    binaryPoints: 2,
    pairingWeeklyCap: 20000,
    pairingMonthlyCap: 80000,
    lifetimeIncomeCeiling: 80000,
    sealingPoint: 80000,
    pairingDepthLimit: null,
    unilevelReach: 5,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: 30,
    nextUpgradePackageLabel: 'Gold',
    salesMatchNote: 'Silver keeps the standard binary traversal and raises the lifetime income ceiling to PHP 80,000 before a further upgrade is needed.',
  },
  30: {
    packageType: 30,
    packageLabel: 'Gold',
    packageAmount: 10000,
    directReferralBonus: 1000,
    binaryValue: 1000,
    binaryPoints: 4,
    pairingWeeklyCap: 40000,
    pairingMonthlyCap: 160000,
    lifetimeIncomeCeiling: 0,
    sealingPoint: 0,
    pairingDepthLimit: null,
    unilevelReach: 7,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: 40,
    nextUpgradePackageLabel: 'Platinum',
    salesMatchNote: 'Gold opens ranking and uses the published PHP 40,000 weekly and PHP 160,000 monthly sales-match caps.',
  },
  40: {
    packageType: 40,
    packageLabel: 'Platinum',
    packageAmount: 25000,
    directReferralBonus: 2500,
    binaryValue: 2500,
    binaryPoints: 10,
    pairingWeeklyCap: 80000,
    pairingMonthlyCap: 320000,
    lifetimeIncomeCeiling: 0,
    sealingPoint: 0,
    pairingDepthLimit: null,
    unilevelReach: 8,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: 50,
    nextUpgradePackageLabel: 'Garnet',
    salesMatchNote: 'Platinum expands sales match and ranking reach into the Manager ladder with PHP 80,000 weekly and PHP 320,000 monthly caps.',
  },
  50: {
    packageType: 50,
    packageLabel: 'Garnet',
    packageAmount: 50000,
    directReferralBonus: 5000,
    binaryValue: 5000,
    binaryPoints: 20,
    pairingWeeklyCap: 120000,
    pairingMonthlyCap: 480000,
    lifetimeIncomeCeiling: 0,
    sealingPoint: 0,
    pairingDepthLimit: null,
    unilevelReach: 9,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: 60,
    nextUpgradePackageLabel: 'Diamond',
    salesMatchNote: 'Garnet keeps the full binary reach, unlocks the full rank ladder, and follows the higher published weekly cap without a Bronze/Silver lifetime ceiling.',
  },
  60: {
    packageType: 60,
    packageLabel: 'Diamond',
    packageAmount: 150000,
    directReferralBonus: 15000,
    binaryValue: 15000,
    binaryPoints: 60,
    pairingWeeklyCap: 300000,
    pairingMonthlyCap: 1200000,
    lifetimeIncomeCeiling: 0,
    sealingPoint: 0,
    pairingDepthLimit: null,
    unilevelReach: 10,
    rankingEligible: true,
    rankingMax: 10,
    rankingMaxLabel: 'AMBASSADOR',
    nextUpgradePackageType: null,
    nextUpgradePackageLabel: null,
    salesMatchNote: 'Diamond holds the widest unilevel reach and the largest published weekly sales-match envelope in the ladder.',
  },
};

function clonePolicy(policy) {
  return { ...policy };
}

function getPackagePolicy(packageType) {
  const numericType = Number(packageType || 0);
  const policy = PACKAGE_POLICY_MAP[numericType];
  if (policy) return clonePolicy(policy);

  return {
    packageType: numericType,
    packageLabel: getAccountTypeName(numericType),
    packageAmount: 0,
    directReferralBonus: 0,
    binaryValue: 0,
    binaryPoints: 0,
    pairingWeeklyCap: 0,
    pairingMonthlyCap: 0,
    lifetimeIncomeCeiling: 0,
    sealingPoint: 0,
    pairingDepthLimit: null,
    unilevelReach: 0,
    rankingEligible: false,
    rankingMax: 0,
    rankingMaxLabel: null,
    nextUpgradePackageType: null,
    nextUpgradePackageLabel: null,
    salesMatchNote: null,
  };
}

function getPackageBinaryValue(packageType) {
  return Number(getPackagePolicy(packageType).binaryValue || 0);
}

function getPackageBinaryPoints(packageType) {
  return Number(getPackagePolicy(packageType).binaryPoints || 0);
}

function getPackagePairingWeeklyCap(packageType) {
  return Number(getPackagePolicy(packageType).pairingWeeklyCap || 0);
}

function getPackageSealingPoint(packageType) {
  return Number(getPackagePolicy(packageType).sealingPoint || 0);
}

function getPackagePairingMonthlyCap(packageType) {
  return Number(getPackagePolicy(packageType).pairingMonthlyCap || 0);
}

function getPackageLifetimeIncomeCeiling(packageType) {
  return Number(getPackagePolicy(packageType).lifetimeIncomeCeiling || 0);
}

function getPackageDefaultSalesMatchReserveCeiling(packageType) {
  const policy = getPackagePolicy(packageType);
  return Number(
    policy.lifetimeIncomeCeiling ||
    policy.pairingMonthlyCap ||
    policy.pairingWeeklyCap ||
    0
  );
}

function getPackagePairingDepthLimit(packageType) {
  const value = getPackagePolicy(packageType).pairingDepthLimit;
  if (value == null) return null;
  return Number(value || 0) || null;
}

function listPackagePolicies() {
  return Object.values(PACKAGE_POLICY_MAP)
    .sort((left, right) => Number(left.packageType) - Number(right.packageType))
    .map(clonePolicy);
}

module.exports = {
  PACKAGE_POLICY_MAP,
  getPackagePolicy,
  getPackageBinaryValue,
  getPackageBinaryPoints,
  getPackagePairingWeeklyCap,
  getPackageSealingPoint,
  getPackagePairingMonthlyCap,
  getPackageLifetimeIncomeCeiling,
  getPackageDefaultSalesMatchReserveCeiling,
  getPackagePairingDepthLimit,
  listPackagePolicies,
};
