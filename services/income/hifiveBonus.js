const crypto = require('crypto');
const { pool } = require('../../config/database');
const { ACCOUNT_TYPES, PRODUCT_TYPES, currentMonthRange, nowMySQL } = require('../../utils/helpers');
const { writeAuditLog } = require('../audit');
const { createProcessKey, createPublicId } = require('../../utils/security');
const { getEffectiveAccountState } = require('../accountState');
const { countsForDirectReferralSource } = require('./directReferral');
const {
  HIFIVE_PRODUCT_TYPE_TO_KEY,
  HIFIVE_PRODUCT_METADATA,
} = require('../../constants/maintenanceProductCatalog');

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

const PRODUCT_TYPE_TO_KEY = HIFIVE_PRODUCT_TYPE_TO_KEY;

const PRODUCT_METADATA = HIFIVE_PRODUCT_METADATA;

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

function normalizeContributorTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return date.getTime();
}

function splitContributorsByClaimUsage(contributors = [], usedCount = 0, timestampKey = 'joinedAt') {
  const safeUsedCount = Math.max(0, Number(usedCount) || 0);
  const sortedAsc = [...contributors].sort((left, right) => {
    const leftTs = normalizeContributorTimestamp(left?.[timestampKey]);
    const rightTs = normalizeContributorTimestamp(right?.[timestampKey]);
    if (leftTs !== rightTs) return leftTs - rightTs;
    return Number(left?.uid || 0) - Number(right?.uid || 0);
  });

  const clampedUsedCount = Math.min(sortedAsc.length, safeUsedCount);
  const used = sortedAsc.slice(0, clampedUsedCount);
  const available = sortedAsc.slice(clampedUsedCount);
  const sortDesc = (items) => [...items].sort((left, right) => {
    const leftTs = normalizeContributorTimestamp(left?.[timestampKey]);
    const rightTs = normalizeContributorTimestamp(right?.[timestampKey]);
    if (leftTs !== rightTs) return rightTs - leftTs;
    return Number(right?.uid || 0) - Number(left?.uid || 0);
  });

  return {
    used: sortDesc(used),
    available: sortDesc(available),
    all: sortDesc(sortedAsc),
  };
}

function summarizeProductReferralRows(rows = []) {
  const qualifyingReferralsByKey = normalizeCountMap(Object.keys(PRODUCT_METADATA));
  const rawPurchasesByKey = normalizeCountMap(Object.keys(PRODUCT_METADATA));
  const contributorsByKey = normalizeCountMap(Object.keys(PRODUCT_METADATA));

  for (const row of rows) {
    const key = PRODUCT_TYPE_TO_KEY[row.producttype];
    if (!key) continue;

    rawPurchasesByKey[key] += Number(row.cnt || 0);
    qualifyingReferralsByKey[key] += 1;
    contributorsByKey[key] = contributorsByKey[key] || [];
    contributorsByKey[key].push({
      uid: Number(row.referralUid),
      username: row.username,
      fullName: fullName(row),
      count: Number(row.cnt || 0),
      lastTransdate: row.lastTransdate,
    });
  }

  return { qualifyingReferralsByKey, rawPurchasesByKey, contributorsByKey };
}

function buildProductSummary({
  qualifyingReferralsByKey,
  rawPurchasesByKey,
  purchasesByKey,
  claimedByKey,
  maintenancePoints,
  threshold = 200,
  contributorsByKey = {},
}) {
  const eligible = maintenancePoints >= threshold;
  const pointsNeeded = Math.max(0, threshold - maintenancePoints);
  const qualifyingCounts = qualifyingReferralsByKey || purchasesByKey || {};
  const rawCounts = rawPurchasesByKey || purchasesByKey || {};

  const products = Object.entries(PRODUCT_METADATA).map(([key, meta]) => {
    const qualifyingReferrals = Number(qualifyingCounts[key] || 0);
    const purchases = Number(rawCounts[key] || 0);
    const claimed = Number(claimedByKey[key] || 0);
    const qualifiedSets = Math.floor(qualifyingReferrals / 5);
    const availableClaims = eligible ? Math.max(0, qualifiedSets - claimed) : 0;
    const remainder = qualifyingReferrals % 5;
    const contributorSplit = splitContributorsByClaimUsage(
      contributorsByKey[key] || [],
      claimed * 5,
      'lastTransdate'
    );

    return {
      key,
      code: meta.code,
      name: meta.name,
      purchasePoints: meta.purchasePoints,
      qualifyingDirectReferrals: qualifyingReferrals,
      directReferralPurchases: purchases,
      qualifiedSets,
      claimedSets: claimed,
      availableClaims,
      blockedClaims: eligible ? 0 : Math.max(0, qualifiedSets - claimed),
      remainingToNextSet: remainder === 0 ? 5 : 5 - remainder,
      eligible,
      contributors: contributorSplit.all,
      availableContributors: contributorSplit.available,
      contributorHistory: contributorSplit.used,
      availableContributorCount: contributorSplit.available.length,
      usedContributorCount: contributorSplit.used.length,
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
    const contributorSplit = splitContributorsByClaimUsage(
      contributorsByPackage[rule.key] || [],
      claimedSets * 5,
      'joinedAt'
    );

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
      contributors: contributorSplit.all,
      availableContributors: contributorSplit.available,
      contributorHistory: contributorSplit.used,
      availableContributorCount: contributorSplit.available.length,
      usedContributorCount: contributorSplit.used.length,
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
  // Hi-Five PRODUCT qualifying RESETS MONTHLY (Minutes #14/B, CONFIRMED 2026-06-21): count
  // only THIS month's distinct directs per product, so unclaimed wait-progress (e.g. 4 of 5)
  // does NOT carry into next month. (Package Hi-Five is all-time/monotonic; PRODUCT is the
  // reset/wait one. Eligibility ≥200 maintenance is already monthly via getMaintenanceProductPoints.)
  const { start, end } = currentMonthRange();
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
       AND DATE_FORMAT(r.transdate, '%Y-%m-%d') >= ?
       AND DATE_FORMAT(r.transdate, '%Y-%m-%d') <= ?
     GROUP BY r.producttype, r.uid, m.username, m.firstname, m.lastname
     ORDER BY r.producttype ASC, cnt DESC, lastTransdate DESC`,
    [uid, start, end]
  );

  return summarizeProductReferralRows(rows);
}

// Hi-Five PRODUCT claimed sets ALSO reset monthly (Minutes #14/B): only THIS month's redeems
// gate this month's availability. Without this, a prior month's redeems (cumulative in
// h5bonustab) would wrongly suppress a member's fresh monthly entitlement. Sourced from
// h5historytab (redeemdate-scoped) to stay consistent with the monthly qualifying window above.
async function getMonthlyRedeemedProductSets(uid) {
  const { start, end } = currentMonthRange();
  const claimed = normalizeCountMap(Object.keys(PRODUCT_METADATA));
  const [rows] = await pool.query(
    `SELECT producttype, COALESCE(SUM(ttlbonus), 0) AS redeemed
       FROM h5historytab
      WHERE uid = ? AND transactiontype = 1
        AND DATE_FORMAT(redeemdate, '%Y-%m-%d') >= ?
        AND DATE_FORMAT(redeemdate, '%Y-%m-%d') <= ?
      GROUP BY producttype`,
    [uid, start, end]
  );
  for (const row of rows) {
    const key = PRODUCT_TYPE_TO_KEY[row.producttype];
    if (key) claimed[key] = Number(row.redeemed || 0);
  }
  return claimed;
}

async function getMaintenanceProductPoints(uid) {
  const { start, end } = currentMonthRange();

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

async function getAllDirectReferralCount(uid) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM usertab
      WHERE drefid = ?`,
    [uid]
  );

  return Number(rows[0]?.total || 0);
}

async function getDirectReferralPackageCounts(uid) {
  const [rows] = await pool.query(
    `SELECT
        child.uid,
        COALESCE(NULLIF(child.currentaccttype, 0), child.accttype) AS packageCode,
        child.accttype,
        child.currentaccttype,
        child.codeid,
        child.cdamount,
        child.cdtotal,
        child.cdstatus,
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
    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    if (!countsForDirectReferralSource(effectiveRow)) {
      continue;
    }

    const rule = PACKAGE_RULES_BY_CODE[Number(effectiveRow.currentaccttype || row.packageCode)];
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
  return getPackageRewardAmountsFromConn(pool);
}

async function getPackageRewardAmountsFromConn(conn) {
  const [rows] = await conn.query(
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

function getClaimStatusLabel(status) {
  switch (status) {
    case 'pending_review':
      return 'Pending Review';
    case 'approved':
      return 'Approved';
    case 'paid':
      return 'Paid';
    case 'forfeited':
      return 'Rejected';
    default:
      return status;
  }
}

function formatPackageClaimRow(row, rewardAmounts = {}) {
  const packageKey = String(row.package_or_product || '').toLowerCase();
  const packageRule = PACKAGE_RULES_BY_KEY[packageKey];
  const qualifyingCount = Number(row.qualifying_count || 0);
  const rewardAmount = Number(rewardAmounts[packageKey] || 0);
  const totalPayout = qualifyingCount * rewardAmount;

  return {
    id: Number(row.id),
    qualificationUid: row.qualification_uid,
    memberUid: Number(row.member_uid),
    username: row.username,
    fullname: fullName(row),
    packageKey,
    packageCode: packageRule?.code || null,
    packageName: packageRule?.name || PRODUCT_TYPES[packageRule?.code] || packageKey,
    qualifyingCount,
    rewardAmount,
    totalPayout,
    status: row.status,
    statusLabel: getClaimStatusLabel(row.status),
    suspiciousFlags: row.suspicious_flags || null,
    adminNotes: row.admin_notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listPackageClaims({ page = 1, perPage = 30, status = '', startDate = '', endDate = '', packageKey = '' } = {}) {
  if (!(await hasHiFiveQualificationTable())) {
    return { records: [], total: 0, page: 1, totalPages: 0 };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.min(100, Math.max(1, Number(perPage) || 30));
  const offset = (safePage - 1) * safePerPage;
  const safeStatus = String(status || '').trim();
  const safePackageKey = String(packageKey || '').trim().toLowerCase();

  const where = [`hq.hifive_type = 'package'`];
  const params = [];

  if (safeStatus) {
    where.push('hq.status = ?');
    params.push(safeStatus);
  }
  if (safePackageKey) {
    where.push('LOWER(hq.package_or_product) = ?');
    params.push(safePackageKey);
  }
  if (startDate) {
    where.push("DATE_FORMAT(hq.created_at, '%Y-%m-%d') >= ?");
    params.push(startDate);
  }
  if (endDate) {
    where.push("DATE_FORMAT(hq.created_at, '%Y-%m-%d') <= ?");
    params.push(endDate);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[countRow], rewardAmounts] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS total
       FROM hifive_qualificationstab hq
       LEFT JOIN memberstab m ON m.uid = hq.member_uid
       ${whereSql}`,
      params
    ).then(([rows]) => rows),
    getPackageRewardAmounts(),
  ]);

  const [rows] = await pool.query(
    `SELECT hq.*, m.username, m.firstname, m.lastname
     FROM hifive_qualificationstab hq
     LEFT JOIN memberstab m ON m.uid = hq.member_uid
     ${whereSql}
     ORDER BY hq.created_at DESC, hq.id DESC
     LIMIT ?, ?`,
    [...params, offset, safePerPage]
  );

  const total = Number(countRow.total || 0);
  return {
    records: rows.map((row) => formatPackageClaimRow(row, rewardAmounts)),
    total,
    page: safePage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

async function getPackageClaimDetails(qualificationUid) {
  if (!(await hasHiFiveQualificationTable())) {
    throw new Error('Package Hi-Five claims are not ready because the qualification table is missing.');
  }

  const [claimRows, rewardAmounts] = await Promise.all([
    pool.query(
      `SELECT hq.*, m.username, m.firstname, m.lastname
       FROM hifive_qualificationstab hq
       LEFT JOIN memberstab m ON m.uid = hq.member_uid
       WHERE hq.qualification_uid = ?
       LIMIT 1`,
      [qualificationUid]
    ).then(([rows]) => rows),
    getPackageRewardAmounts(),
  ]);

  if (claimRows.length === 0) {
    throw new Error('Package claim not found.');
  }

  const claim = formatPackageClaimRow(claimRows[0], rewardAmounts);
  const status = await buildHiFiveStatus(claim.memberUid);
  const packageContributors = (status.packageBonus?.packages || []).find((item) => item.key === claim.packageKey)?.contributors || [];
  const contributorUids = packageContributors.map((item) => Number(item.uid || 0)).filter((value) => value > 0);

  let registrationAuditRows = [];
  let codeUsageRows = [];
  if (contributorUids.length > 0) {
    const placeholders = contributorUids.map(() => '?').join(',');
    registrationAuditRows = await pool.query(
      `SELECT new_member_uid, sponsor_uid, referral_slug, activation_code, requested_position,
              enforced_position, placement_policy_mode, placement_policy_reason,
              registration_ip, device_fingerprint, status, consumed_at
       FROM public_registration_audittab
       WHERE new_member_uid IN (${placeholders})`,
      contributorUids
    ).then(([rows]) => rows).catch(() => []);

    codeUsageRows = await pool.query(
      `SELECT to_uid, code, event_type, from_uid, actor_uid, referral_token, notes, process_key
       FROM activation_code_usagetab
       WHERE to_uid IN (${placeholders})`,
      contributorUids
    ).then(([rows]) => rows).catch(() => []);
  }

  const auditByUid = new Map();
  for (const row of registrationAuditRows) {
    auditByUid.set(Number(row.new_member_uid || 0), row);
  }
  const usageByUid = new Map();
  for (const row of codeUsageRows) {
    usageByUid.set(Number(row.to_uid || 0), row);
  }

  return {
    claim,
    summary: {
      totalContributors: packageContributors.length,
      totalQualifiedSets: Math.floor(packageContributors.length / 5),
      currentStatus: claim.status,
      currentStatusLabel: claim.statusLabel,
      totalPayout: claim.totalPayout,
    },
    contributors: packageContributors.map((contributor, index) => {
      const audit = auditByUid.get(Number(contributor.uid || 0)) || null;
      const usage = usageByUid.get(Number(contributor.uid || 0)) || null;
      return {
        orderNo: index + 1,
        ...contributor,
        registrationAudit: audit ? {
          activationCode: audit.activation_code || null,
          referralSlug: audit.referral_slug || null,
          requestedPosition: audit.requested_position ?? null,
          enforcedPosition: audit.enforced_position ?? null,
          placementPolicyMode: audit.placement_policy_mode || null,
          placementPolicyReason: audit.placement_policy_reason || null,
          registrationIp: audit.registration_ip || null,
          consumedAt: audit.consumed_at || null,
        } : null,
        codeUsage: usage ? {
          code: usage.code || null,
          eventType: usage.event_type || null,
          referralToken: usage.referral_token || null,
          processKey: usage.process_key || null,
          notes: (() => {
            try {
              return usage.notes ? JSON.parse(usage.notes) : null;
            } catch {
              return usage.notes || null;
            }
          })(),
        } : null,
      };
    }),
  };
}

async function approvePackageClaim(qualificationUid, { adminUid = null, adminNotes = '', req = null } = {}) {
  if (!(await hasHiFiveQualificationTable())) {
    throw new Error('Package Hi-Five claims are not ready because the qualification table is missing.');
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [claimRows] = await conn.query(
      `SELECT hq.*, m.username, m.firstname, m.lastname
       FROM hifive_qualificationstab hq
       LEFT JOIN memberstab m ON m.uid = hq.member_uid
       WHERE hq.qualification_uid = ?
       LIMIT 1
       FOR UPDATE`,
      [qualificationUid]
    );

    if (claimRows.length === 0) {
      throw new Error('Package claim not found.');
    }

    const claim = claimRows[0];
    if (claim.hifive_type !== 'package') {
      throw new Error('Claim is not a package Hi-Five claim.');
    }
    if (claim.status !== 'pending_review') {
      throw new Error('Claim has already been processed.');
    }

    const rewardAmounts = await getPackageRewardAmountsFromConn(conn);
    const formattedClaim = formatPackageClaimRow(claim, rewardAmounts);
    if (!(formattedClaim.packageKey in rewardAmounts) || formattedClaim.rewardAmount <= 0) {
      throw new Error('Unable to resolve package reward amount for this claim.');
    }

    const [walletRows] = await conn.query(
      'SELECT ttlcashbalance, COALESCE(ttlincome5,0) AS paid FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE',
      [claim.member_uid]
    );

    // MONOTONIC GUARD (2026-06-21): Hi-Five is auto-credited via ttlincome5. Approving a claim
    // must NEVER pay entitlement that is already in ttlincome5 (legacy + auto-credit), or it
    // double-pays. Credit only the still-unpaid portion.
    const alreadyPaid = Number(walletRows[0]?.paid || 0);
    let hifiveEntitlement = 0;
    try {
      const status = await buildHiFiveStatus(claim.member_uid);
      hifiveEntitlement = (status?.packageBonus?.packages || []).reduce(
        (sum, p) => sum + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0), 0
      );
    } catch (_) { hifiveEntitlement = alreadyPaid + Number(formattedClaim.totalPayout || 0); }
    const remainingOwed = Math.max(0, hifiveEntitlement - alreadyPaid);
    const creditAmount = Math.min(Number(formattedClaim.totalPayout || 0), remainingOwed);

    const beginningBalance = Number(walletRows[0]?.ttlcashbalance || 0);
    const endingBalance = beginningBalance + creditAmount;
    const now = nowMySQL();
    const processKey = createProcessKey(['hifive', 'package-claim', qualificationUid]);

    // Only move money for the still-unpaid portion. If creditAmount is 0 (entitlement already
    // covered by ttlincome5), the claim is still marked paid below but no cash is credited.
    if (creditAmount > 0) {
      await conn.query(
        `INSERT INTO payouthistorytab
         (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
          income1, income2, income3, income4, income5, income6,
          income7, income8, income9, income10,
          encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
          cashstatus, transdate, transactiontype, stockistid, processid)
         VALUES (NULL, ?, NULL, ?, ?, 0,
          0, 0, 0, 0, ?, 0,
          0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, ?, 1, 0, ?)`,
        [
          claim.member_uid,
          beginningBalance,
          endingBalance,
          creditAmount,
          now,
          processKey,
        ]
      );

      await conn.query(
        `INSERT INTO payouttotaltab
         (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome51, ttlincome6,
          ttlcashbalance, ttlpointsbalance, transdate)
         VALUES (?, NULL, 0, 0, 0, 0, ?, 0, 0, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
          ttlincome5 = ttlincome5 + VALUES(ttlincome5),
          ttlcashbalance = VALUES(ttlcashbalance),
          transdate = VALUES(transdate)`,
        [claim.member_uid, creditAmount, endingBalance, now]
      );

      try {
        await conn.query(
          `INSERT INTO income_eventstab
           (event_uid, process_key, beneficiary_uid, income_type, source_ref_uid, source_ref_type,
            gross_amount, tax_deduction, processing_fee, cd_deduction, maintenance_fee,
            net_amount, status, credited_at)
           VALUES (?, ?, ?, 'hifive_package', ?, 'hifive_qualificationstab',
            ?, 0, 0, 0, 0, ?, 'credited', CURRENT_TIMESTAMP(6))`,
          [
            createPublicId(),
            processKey,
            claim.member_uid,
            qualificationUid,
            creditAmount,
            creditAmount,
          ]
        );
      } catch (ledgerError) {
        if (ledgerError.code !== 'ER_NO_SUCH_TABLE') {
          throw ledgerError;
        }
      }
    }

    await conn.query(
      `UPDATE hifive_qualificationstab
       SET status = 'paid',
           admin_notes = ?,
           updated_at = CURRENT_TIMESTAMP(6)
       WHERE qualification_uid = ?
       LIMIT 1`,
      [String(adminNotes || '').trim() || 'Approved and paid by admin', qualificationUid]
    );

    await writeAuditLog(conn, {
      req,
      actorUid: adminUid,
      actorRole: 'admin',
      action: 'hifive.package_claim.approve',
      targetUid: claim.member_uid,
      targetTable: 'hifive_qualificationstab',
      targetId: qualificationUid,
      beforeState: {
        status: claim.status,
        totalPayout: formattedClaim.totalPayout,
        balanceBefore: beginningBalance,
      },
      afterState: {
        status: 'paid',
        totalPayout: formattedClaim.totalPayout,
        balanceAfter: endingBalance,
        packageKey: formattedClaim.packageKey,
      },
    });

    await conn.commit();
    return {
      success: true,
      claim: {
        ...formattedClaim,
        status: 'paid',
        statusLabel: getClaimStatusLabel('paid'),
        adminNotes: String(adminNotes || '').trim() || 'Approved and paid by admin',
      },
      creditedAmount: creditAmount,
      alreadyPaidSkipped: Math.max(0, Number(formattedClaim.totalPayout || 0) - creditAmount),
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function rejectPackageClaim(qualificationUid, { adminUid = null, adminNotes = '', req = null } = {}) {
  if (!(await hasHiFiveQualificationTable())) {
    throw new Error('Package Hi-Five claims are not ready because the qualification table is missing.');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claimRows] = await conn.query(
      `SELECT *
       FROM hifive_qualificationstab
       WHERE qualification_uid = ?
       LIMIT 1
       FOR UPDATE`,
      [qualificationUid]
    );

    if (claimRows.length === 0) {
      throw new Error('Package claim not found.');
    }

    const claim = claimRows[0];
    if (claim.hifive_type !== 'package') {
      throw new Error('Claim is not a package Hi-Five claim.');
    }
    if (claim.status !== 'pending_review') {
      throw new Error('Claim has already been processed.');
    }

    const note = String(adminNotes || '').trim() || 'Rejected by admin';
    await conn.query(
      `UPDATE hifive_qualificationstab
       SET status = 'forfeited',
           admin_notes = ?,
           updated_at = CURRENT_TIMESTAMP(6)
       WHERE qualification_uid = ?
       LIMIT 1`,
      [note, qualificationUid]
    );

    await writeAuditLog(conn, {
      req,
      actorUid: adminUid,
      actorRole: 'admin',
      action: 'hifive.package_claim.reject',
      targetUid: claim.member_uid,
      targetTable: 'hifive_qualificationstab',
      targetId: qualificationUid,
      beforeState: { status: claim.status },
      afterState: { status: 'forfeited', adminNotes: note },
    });

    await conn.commit();
    return { success: true, status: 'forfeited', statusLabel: getClaimStatusLabel('forfeited') };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
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
  const [productClaimedByKey, directReferralProducts, maintenancePoints, directReferralPackages, rewardAmounts, packageClaimedSets, directReferralCount] =
    await Promise.all([
      // PRODUCT claimed = THIS month's redeems (Minutes #14/B monthly reset), not the all-time
      // h5bonustab counter — kept consistent with the monthly qualifying window below.
      getMonthlyRedeemedProductSets(uid),
      getDirectReferralProductPurchases(uid),
      getMaintenanceProductPoints(uid),
      getDirectReferralPackageCounts(uid),
      getPackageRewardAmounts(),
      getPackageClaimedSets(uid),
      getAllDirectReferralCount(uid),
    ]);

  const productBonus = buildProductSummary({
    qualifyingReferralsByKey: directReferralProducts.qualifyingReferralsByKey,
    rawPurchasesByKey: directReferralProducts.rawPurchasesByKey,
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
      directReferralCount,
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
  // DISABLED 2026-06-21: Hi-Five package cash is now AUTO-CREDITED on the monotonic basis
  // (autoCreditEligibleHiFivePackages: owed = max(0, entitlement - ttlincome5)). Manual claim
  // submission is gone because approve was additive and would DOUBLE-PAY entitlement that
  // ttlincome5 already records (legacy + auto-credit). Members no longer submit claims.
  void uid; void packageKey; void quantity;
  const err = new Error('Hi-Five package cash is now credited automatically — no claim submission is needed.');
  err.statusCode = 410;
  err.code = 'HIFIVE_AUTO_CREDITED';
  throw err;
}

/**
 * Auto-credit Hi-Five PACKAGE cash on the MONOTONIC basis (mirrors SMB ttlincome2):
 *
 *     owed = max(0, totalHiFiveEntitlement - ttlincome5_alreadyPaid)
 *
 * where entitlement = SUM over packages of (qualifiedSets * packageReward). It credits `owed`
 * exactly once; after crediting, ttlincome5 == entitlement so a re-run owes 0. Because the
 * basis is the authoritative ttlincome5 (which already holds legacy/manual hi-five that has NO
 * qualification row), this can NEVER double-pay the historical backlog — it only ever pays the
 * un-paid delta. New qualifying sets raise entitlement and auto-credit on the next load.
 *
 * The credit is written to payouthistorytab (transactiontype=1, income5) so it appears in the
 * member's transaction history (keeping the 1:1 history==totals reconciliation intact).
 *
 * MUST be called under the per-uid income lock (calculateAndStoreIncome's GET_LOCK) so two
 * concurrent page loads cannot both credit the same delta.
 */
async function autoCreditEligibleHiFivePackages(uid) {
  if (!(await hasHiFiveQualificationTable())) return { credited: 0, owed: 0 };

  const status = await buildHiFiveStatus(uid).catch(() => null);
  const packages = status?.packageBonus?.packages || [];
  const entitlement = packages.reduce(
    (sum, p) => sum + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0),
    0
  );
  if (entitlement < 1) return { credited: 0, owed: 0, entitlement: 0 };

  // Own transaction + FOR UPDATE on the wallet row makes this atomic AND self-serializing:
  // a concurrent call blocks on the row lock, then re-reads ttlincome5 (now caught up) and
  // owes 0 — so it cannot double-credit even outside the income GET_LOCK.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT COALESCE(ttlincome5,0) AS paid, COALESCE(ttlcashbalance,0) AS bal FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE',
      [uid]
    );
    const alreadyPaid = Number(rows[0]?.paid || 0);
    const owed = Math.max(0, entitlement - alreadyPaid);
    if (owed < 1) {
      await conn.commit();
      return { credited: 0, owed: 0, entitlement, alreadyPaid };
    }

    const beginningBalance = Number(rows[0]?.bal || 0);
    const endingBalance = beginningBalance + owed;
    const now = nowMySQL();
    const processKey = createProcessKey(['hifive', 'auto-credit', uid, entitlement]);

    await conn.query(
      `INSERT INTO payouthistorytab
       (pid, uid, mainid, beginningbalance, endingbalance, cashbalance,
        income1, income2, income3, income4, income5, income6,
        income7, income8, income9, income10,
        encashment1, tax_1, encashment2, tax_2, encashmentfee, cddeduction,
        cashstatus, transdate, transactiontype, stockistid, processid)
       VALUES (NULL, ?, NULL, ?, ?, 0,
        0, 0, 0, 0, ?, 0,
        0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, ?, 1, 0, ?)`,
      [uid, beginningBalance, endingBalance, owed, now, processKey]
    );

    await conn.query(
      `INSERT INTO payouttotaltab
       (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome51, ttlincome6,
        ttlcashbalance, ttlpointsbalance, transdate)
       VALUES (?, NULL, 0, 0, 0, 0, ?, 0, 0, ?, 0, ?)
       ON DUPLICATE KEY UPDATE
        ttlincome5 = ttlincome5 + VALUES(ttlincome5),
        ttlcashbalance = VALUES(ttlcashbalance),
        transdate = VALUES(transdate)`,
      [uid, owed, endingBalance, now]
    );

    try {
      await conn.query(
        `INSERT INTO income_eventstab
         (event_uid, process_key, beneficiary_uid, income_type, source_ref_uid, source_ref_type,
          gross_amount, tax_deduction, processing_fee, cd_deduction, maintenance_fee,
          net_amount, status, credited_at)
         VALUES (?, ?, ?, 'hifive_package', ?, 'hifive_autocredit',
          ?, 0, 0, 0, 0, ?, 'credited', CURRENT_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE event_uid = event_uid`,
        [createPublicId(), processKey, uid, String(uid), owed, owed]
      );
    } catch (ledgerError) {
      if (ledgerError.code !== 'ER_NO_SUCH_TABLE') throw ledgerError;
    }

    await conn.commit();
    return { credited: owed, owed, entitlement, alreadyPaid };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  PRODUCT_COLS,
  PRODUCT_TYPE_TO_KEY,
  PRODUCT_METADATA,
  PACKAGE_RULES,
  autoCreditEligibleHiFivePackages,
  summarizeProductReferralRows,
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
  listPackageClaims,
  approvePackageClaim,
  rejectPackageClaim,
  formatPackageClaimRow,
  getPackageClaimDetails,
};
