const crypto = require('crypto');
const { pool } = require('../../config/database');
const { ACCOUNT_TYPES, previousMonthRange } = require('../../utils/helpers');

const PRODUCT_COLS = {
  bl: 'prod0',
  gl: 'prod1',
  glc: 'prod2',
  cm: 'prod3',
  cd: 'prod4',
  mgt: 'prod5',
  vz: 'prod6',
  cmm: 'prod7',
  bkc: 'prod8',
};

const PRODUCT_TYPE_TO_KEY = {
  100: 'bl',
  101: 'gl',
  102: 'glc',
  103: 'cm',
  104: 'cd',
  105: 'mgt',
  106: 'vz',
  107: 'cmm',
  108: 'bkc',
};

const PRODUCT_METADATA = {
  bl: { code: 100, name: 'Nogatu Barley', purchasePoints: 50 },
  gl: { code: 101, name: 'Glutathione', purchasePoints: 45 },
  glc: { code: 102, name: 'Glutathione with Collagen', purchasePoints: 40 },
  cm: { code: 103, name: 'Nogatu Coffee Mix', purchasePoints: 40 },
  cd: { code: 104, name: 'Chocolate Drink', purchasePoints: 45 },
  mgt: { code: 105, name: 'Nogatu Mangosteen', purchasePoints: 30 },
  vz: { code: 106, name: 'Vitamin Zinc', purchasePoints: 40 },
  cmm: { code: 107, name: 'MAX Coffee Mix', purchasePoints: 100 },
  bkc: { code: 108, name: 'Black Coffee', purchasePoints: 10 },
};

const PACKAGE_RULES = [
  { key: 'bronze', code: 10, name: 'Bronze' },
  { key: 'silver', code: 20, name: 'Silver' },
  { key: 'gold', code: 30, name: 'Gold' },
  { key: 'platinum', code: 40, name: 'Platinum' },
  { key: 'garnet', code: 50, name: 'Garnet' },
  { key: 'diamond', code: 60, name: 'Diamond' },
];

const PACKAGE_RULES_BY_KEY = Object.fromEntries(PACKAGE_RULES.map((rule) => [rule.key, rule]));
const PACKAGE_RULES_BY_CODE = Object.fromEntries(PACKAGE_RULES.map((rule) => [rule.code, rule]));

let hifiveQualificationTableAvailable;

async function hasHiFiveQualificationTable() {
  if (typeof hifiveQualificationTableAvailable === 'boolean') {
    return hifiveQualificationTableAvailable;
  }

  try {
    const [rows] = await pool.query("SHOW TABLES LIKE 'hifive_qualificationstab'");
    hifiveQualificationTableAvailable = rows.length > 0;
  } catch (error) {
    hifiveQualificationTableAvailable = false;
  }

  return hifiveQualificationTableAvailable;
}

function fullName(row) {
  return [row.firstname, row.lastname].filter(Boolean).join(' ').trim() || row.username || `UID ${row.uid}`;
}

function normalizeCountMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function buildProductSummary({ purchasesByKey, claimedByKey, maintenancePoints, threshold = 200, contributorsByKey = {} }) {
  const eligible = maintenancePoints >= threshold;
  const pointsNeeded = Math.max(0, threshold - maintenancePoints);

  const products = Object.entries(PRODUCT_METADATA).map(([key, meta]) => {
    const purchases = Number(purchasesByKey[key] || 0);
    const claimed = Number(claimedByKey[key] || 0);
    const qualifiedSets = Math.floor(purchases / 5);
    const availableClaims = eligible ? Math.max(0, qualifiedSets - claimed) : 0;
    const remainder = purchases % 5;

    return {
      key,
      code: meta.code,
      name: meta.name,
      purchasePoints: meta.purchasePoints,
      directReferralPurchases: purchases,
      qualifiedSets,
      claimedSets: claimed,
      availableClaims,
      blockedClaims: eligible ? 0 : Math.max(0, qualifiedSets - claimed),
      remainingToNextSet: remainder === 0 ? 5 : 5 - remainder,
      eligible,
      contributors: contributorsByKey[key] || [],
    };
  });

  return {
    maintenancePoints,
    threshold,
    eligible,
    pointsNeeded,
    totalAvailableClaims: products.reduce((sum, item) => sum + item.availableClaims, 0),
    totalBlockedClaims: products.reduce((sum, item) => sum + item.blockedClaims, 0),
    products,
  };
}

function buildPackageSummary({ directReferralPackages, claimedPackageSets, rewardAmounts, contributorsByPackage = {} }) {
  const packages = PACKAGE_RULES.map((rule) => {
    const referralCount = Number(directReferralPackages[rule.key] || 0);
    const claimedSets = Number(claimedPackageSets[rule.key] || 0);
    const qualifiedSets = Math.floor(referralCount / 5);
    const availableClaims = Math.max(0, qualifiedSets - claimedSets);
    const rewardAmount = Number(rewardAmounts[rule.key] || 0);
    const remainder = referralCount % 5;

    return {
      key: rule.key,
      code: rule.code,
      name: rule.name,
      rewardAmount,
      directReferralCount: referralCount,
      qualifiedSets,
      claimedSets,
      availableClaims,
      availableCashAmount: availableClaims * rewardAmount,
      remainingToNextSet: remainder === 0 ? 5 : 5 - remainder,
      contributors: contributorsByPackage[rule.key] || [],
    };
  });

  return {
    totalAvailableClaims: packages.reduce((sum, item) => sum + item.availableClaims, 0),
    totalAvailableCashAmount: packages.reduce((sum, item) => sum + item.availableCashAmount, 0),
    packages,
  };
}

async function checkH5Bonus(uid) {
  const [rows] = await pool.query('SELECT * FROM h5bonustab WHERE uid = ?', [uid]);

  if (rows.length === 0) {
    return normalizeCountMap(Object.keys(PRODUCT_METADATA));
  }

  const row = rows[0];
  return {
    bl: Number(row.prod0 || 0),
    gl: Number(row.prod1 || 0),
    glc: Number(row.prod2 || 0),
    cm: Number(row.prod3 || 0),
    cd: Number(row.prod4 || 0),
    mgt: Number(row.prod5 || 0),
    vz: Number(row.prod6 || 0),
    cmm: Number(row.prod7 || 0),
    bkc: Number(row.prod8 || 0),
  };
}

async function getDirectReferralProductPurchases(uid) {
  const [rows] = await pool.query(
    `SELECT
        r.producttype,
        r.uid AS referralUid,
        COUNT(*) AS cnt,
        MAX(r.transdate) AS lastTransdate,
        m.username,
        m.firstname,
        m.lastname
     FROM usertab child
     INNER JOIN repurchasetab r ON r.uid = child.uid
     LEFT JOIN memberstab m ON m.uid = child.uid
     WHERE child.drefid = ?
       AND r.producttype >= 100
     GROUP BY r.producttype, r.uid, m.username, m.firstname, m.lastname
     ORDER BY r.producttype ASC, cnt DESC, lastTransdate DESC`,
    [uid]
  );

  const purchasesByKey = normalizeCountMap(Object.keys(PRODUCT_METADATA));
  const contributorsByKey = normalizeCountMap(Object.keys(PRODUCT_METADATA));

  for (const row of rows) {
    const key = PRODUCT_TYPE_TO_KEY[row.producttype];
    if (!key) continue;

    purchasesByKey[key] += Number(row.cnt || 0);
    contributorsByKey[key] = contributorsByKey[key] || [];
    contributorsByKey[key].push({
      uid: Number(row.referralUid),
      username: row.username,
      fullName: fullName(row),
      count: Number(row.cnt || 0),
      lastTransdate: row.lastTransdate,
    });
  }

  return { purchasesByKey, contributorsByKey };
}

async function getMaintenanceProductPoints(uid) {
  const { start, end } = previousMonthRange();

  const [rows] = await pool.query(
    `SELECT SUM(incentivepoints1) AS ttlpoints
     FROM repurchasetab
     WHERE uid = ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
       AND producttype >= 100`,
    [uid, start, end]
  );

  return Number(rows[0]?.ttlpoints || 0);
}

async function getDirectReferralPackageCounts(uid) {
  const [rows] = await pool.query(
    `SELECT
        child.uid,
        COALESCE(NULLIF(child.currentaccttype, 0), child.accttype) AS packageCode,
        child.datereg,
        m.username,
        m.firstname,
        m.lastname
     FROM usertab child
     LEFT JOIN memberstab m ON m.uid = child.uid
     WHERE child.drefid = ?`,
    [uid]
  );

  const counts = normalizeCountMap(PACKAGE_RULES.map((rule) => rule.key));
  const contributorsByPackage = normalizeCountMap(PACKAGE_RULES.map((rule) => rule.key));

  for (const row of rows) {
    const rule = PACKAGE_RULES_BY_CODE[Number(row.packageCode)];
    if (!rule) continue;

    counts[rule.key] += 1;
    contributorsByPackage[rule.key] = contributorsByPackage[rule.key] || [];
    contributorsByPackage[rule.key].push({
      uid: Number(row.uid),
      username: row.username,
      fullName: fullName(row),
      joinedAt: row.datereg,
      packageName: rule.name,
    });
  }

  return { counts, contributorsByPackage };
}

async function getPackageRewardAmounts() {
  const [rows] = await pool.query(
    `SELECT producttype, MAX(productamount) AS amount
     FROM codestab
     WHERE producttype IN (10, 20, 30, 40, 50, 60)
     GROUP BY producttype`
  );

  const rewardAmounts = normalizeCountMap(PACKAGE_RULES.map((rule) => rule.key));

  for (const row of rows) {
    const rule = PACKAGE_RULES_BY_CODE[Number(row.producttype)];
    if (!rule) continue;
    rewardAmounts[rule.key] = Number(row.amount || 0);
  }

  return rewardAmounts;
}

async function getPackageClaimedSets(uid) {
  if (!(await hasHiFiveQualificationTable())) {
    return normalizeCountMap(PACKAGE_RULES.map((rule) => rule.key));
  }

  const [rows] = await pool.query(
    `SELECT package_or_product, SUM(qualifying_count) AS qualifyingCount
     FROM hifive_qualificationstab
     WHERE member_uid = ?
       AND hifive_type = 'package'
       AND status IN ('pending_review', 'approved', 'paid')
     GROUP BY package_or_product`,
    [uid]
  );

  const claimedSets = normalizeCountMap(PACKAGE_RULES.map((rule) => rule.key));

  for (const row of rows) {
    const key = String(row.package_or_product || '').toLowerCase();
    if (!(key in claimedSets)) continue;
    claimedSets[key] = Number(row.qualifyingCount || 0);
  }

  return claimedSets;
}

async function buildHiFiveStatus(uid) {
  const [productClaimedByKey, directReferralProducts, maintenancePoints, directReferralPackages, rewardAmounts, packageClaimedSets] =
    await Promise.all([
      checkH5Bonus(uid),
      getDirectReferralProductPurchases(uid),
      getMaintenanceProductPoints(uid),
      getDirectReferralPackageCounts(uid),
      getPackageRewardAmounts(),
      getPackageClaimedSets(uid),
    ]);

  const productBonus = buildProductSummary({
    purchasesByKey: directReferralProducts.purchasesByKey,
    claimedByKey: productClaimedByKey,
    maintenancePoints,
    contributorsByKey: directReferralProducts.contributorsByKey,
  });

  const packageBonus = buildPackageSummary({
    directReferralPackages: directReferralPackages.counts,
    claimedPackageSets: packageClaimedSets,
    rewardAmounts,
    contributorsByPackage: directReferralPackages.contributorsByPackage,
  });

  return {
    summary: {
      directReferralCount: Object.values(directReferralPackages.counts).reduce((sum, count) => sum + Number(count || 0), 0),
      maintenancePoints,
      maintenanceThreshold: 200,
      productEligible: productBonus.eligible,
      productPointsNeeded: productBonus.pointsNeeded,
    },
    packageBonus,
    productBonus,
    // Backward-compatible payload for any legacy consumers.
    products: productBonus.products.map((product) => ({
      key: product.key,
      name: product.name,
      bonus: product.claimedSets,
      purchases: product.directReferralPurchases,
      redeemable: product.availableClaims,
    })),
  };
}

async function insertProductRedeem(uid, bonusType, totalBonus) {
  const col = PRODUCT_COLS[bonusType];
  if (!col) throw new Error('Invalid product Hi-Five type');

  const productTypeMap = Object.entries(PRODUCT_TYPE_TO_KEY).find(([, value]) => value === bonusType);
  const productType = productTypeMap ? Number(productTypeMap[0]) : 0;

  await pool.query(
    `INSERT INTO h5bonustab (uid, prod0, prod1, prod2, prod3, prod4, prod5, prod6, prod7, prod8, lastprodupdate, lasttransupdate)
     VALUES (
       ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, CURDATE(), CURDATE()
     )
     ON DUPLICATE KEY UPDATE ${col} = ${col} + VALUES(${col}), lastprodupdate = CURDATE(), lasttransupdate = CURDATE()`,
    [uid]
  );

  await pool.query(
    `UPDATE h5bonustab
     SET ${col} = ${col} + ?, lastprodupdate = CURDATE(), lasttransupdate = CURDATE()
     WHERE uid = ?`,
    [totalBonus, uid]
  );

  await pool.query(
    `INSERT INTO h5historytab (pid, uid, producttype, ttlbonus, redeemstatus, redeemdate, transactiontype, processid)
     VALUES (NULL, ?, ?, ?, 0, NOW(), 1, ?)`,
    [uid, productType, totalBonus, crypto.randomUUID()]
  );

  return true;
}

async function submitPackageClaim(uid, packageKey, quantity) {
  if (!(await hasHiFiveQualificationTable())) {
    throw new Error('Package Hi-Five claims are not ready because the qualification table is missing.');
  }

  const normalizedKey = String(packageKey || '').toLowerCase();
  const rule = PACKAGE_RULES_BY_KEY[normalizedKey];
  if (!rule) {
    throw new Error('Invalid package Hi-Five type.');
  }

  const claimCount = Math.max(1, Number(quantity) || 1);
  const now = new Date().toISOString();

  for (let index = 0; index < claimCount; index += 1) {
    await pool.query(
      `INSERT INTO hifive_qualificationstab
       (qualification_uid, member_uid, hifive_type, trigger_event_uid, package_or_product, qualifying_count, status, suspicious_flags, admin_notes)
       VALUES (?, ?, 'package', ?, ?, 1, 'pending_review', NULL, ?)`,
      [
        crypto.randomUUID(),
        uid,
        `package:${normalizedKey}:${now}:${index}:${crypto.randomUUID()}`,
        normalizedKey,
        'Member-submitted package Hi-Five cash claim',
      ]
    );
  }

  return true;
}

module.exports = {
  PRODUCT_COLS,
  PRODUCT_TYPE_TO_KEY,
  PRODUCT_METADATA,
  PACKAGE_RULES,
  checkH5Bonus,
  getDirectReferralProductPurchases,
  getMaintenanceProductPoints,
  getDirectReferralPackageCounts,
  getPackageRewardAmounts,
  getPackageClaimedSets,
  buildProductSummary,
  buildPackageSummary,
  buildHiFiveStatus,
  insertProductRedeem,
  submitPackageClaim,
};
