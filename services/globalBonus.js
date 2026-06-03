/**
 * Global Bonus service
 * Pool = 2% of annual net sales, distributed only for fully completed years.
 */
const { pool } = require('../config/database');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('./schemaReadiness');

const STOCKIST_PORTIONS = {
  2: { points: 1, label: 'Mobile Stockist' },
  3: { points: 2, label: 'City Stockist' },
  4: { points: 3, label: 'Provincial Stockist' },
};

function toMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function getCurrentYear(now = new Date()) {
  return Number(now.getFullYear());
}

function getLastClosedYear(now = new Date()) {
  return getCurrentYear(now) - 1;
}

function normalizeAnnualYear(year, now = new Date()) {
  const fallback = getLastClosedYear(now);
  const normalized = Number(year) || fallback;
  return Math.max(2000, normalized);
}

function assertClosedDistributionYear(year, now = new Date()) {
  const numericYear = normalizeAnnualYear(year, now);
  if (numericYear >= getCurrentYear(now)) {
    throw new Error('Global bonus can only be distributed for a fully completed year.');
  }
  return numericYear;
}

async function tableExists(tableName) {
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function getTableColumns(tableName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return new Set(rows.map((r) => r.name));
}

async function ensureGlobalBonusTables() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.GLOBAL_BONUS, 'Global bonus');

  await pool.query(
    `UPDATE globalbonus_poolstab
     SET period_scope = CASE
       WHEN COALESCE(period_month, 0) = 0 THEN 'annual'
       ELSE 'monthly'
     END
     WHERE period_scope IS NULL OR period_scope = ''`
  ).catch(() => {});

  await pool.query(
    `UPDATE globalbonus_membertab
     SET period_scope = CASE
       WHEN COALESCE(period_month, 0) = 0 THEN 'annual'
       ELSE 'monthly'
     END
     WHERE period_scope IS NULL OR period_scope = ''`
  ).catch(() => {});
}

async function getRankingMap() {
  const exists = await tableExists('rankingstab');
  if (!exists) return new Map();

  const cols = await getTableColumns('rankingstab');
  const rankColumn = cols.has('rank_level')
    ? 'rank_level'
    : (cols.has('current_rank') ? 'current_rank' : null);
  if (!rankColumn || !cols.has('uid')) return new Map();

  const [rows] = await pool.query(
    `SELECT uid, ${rankColumn} AS rankLevel
     FROM rankingstab
     WHERE ${rankColumn} > 0`
  );

  const rankMap = new Map();
  for (const row of rows) {
    const uid = Number(row.uid);
    const rank = Number(row.rankLevel || 0);
    if (!rankMap.has(uid) || rank > rankMap.get(uid)) {
      rankMap.set(uid, rank);
    }
  }
  return rankMap;
}

function getStockistPortion(stockistId) {
  const sid = Number(stockistId || 0);
  if (STOCKIST_PORTIONS[sid]) return STOCKIST_PORTIONS[sid];
  if (sid >= 4) return STOCKIST_PORTIONS[4];
  return { points: 0, label: null };
}

function buildGlobalBonusVisibility({ eligible, labels = [] }) {
  if (eligible) {
    return {
      visibilityState: 'unlocked',
      interactive: true,
      fullVisibility: true,
      lockedReason: null,
      unlockedBy: labels,
    };
  }

  return {
    visibilityState: 'locked',
    interactive: false,
    fullVisibility: false,
    lockedReason: 'Global bonus unlocks for qualified Diamond, Ambassador, or eligible Stockist accounts.',
    unlockedBy: [],
  };
}

function getPortionDetails(userRow, rankLevel) {
  const labels = [];
  let portions = 0;

  if (Number(userRow.currentaccttype) === 60) {
    portions += 1;
    labels.push('Diamond');
  }

  if (Number(rankLevel || 0) >= 10) {
    portions += 1;
    labels.push('Ambassador');
  }

  const stockist = getStockistPortion(userRow.stockistid);
  if (stockist.points > 0) {
    portions += stockist.points;
    labels.push(stockist.label);
  }

  return {
    portions,
    memberType: labels.join(' + ') || null,
    labels,
  };
}

async function getAnnualNetSales(year) {
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(productamount), 0) AS totalNetSales
     FROM codestab
     WHERE codestatus = 2
       AND producttype >= 10 AND producttype <= 90
       AND YEAR(dateused) = ?`,
    [year]
  );
  return toMoney(rows[0]?.totalNetSales || 0);
}

async function getEligibleMemberRows() {
  const [rows] = await pool.query(
    `SELECT uid, currentaccttype, stockistid
     FROM usertab
     WHERE uid = mainid`
  );
  return rows;
}

async function calculateGlobalBonus(yearInput) {
  await ensureGlobalBonusTables();
  const year = assertClosedDistributionYear(yearInput);
  const [totalNetSales, rankMap, members] = await Promise.all([
    getAnnualNetSales(year),
    getRankingMap(),
    getEligibleMemberRows(),
  ]);

  const bonusPool = toMoney(totalNetSales * 0.02);
  const recipients = [];
  let totalPortions = 0;

  for (const member of members) {
    const uid = Number(member.uid);
    const rankLevel = rankMap.get(uid) || 0;
    const detail = getPortionDetails(member, rankLevel);
    if (detail.portions <= 0) continue;

    totalPortions += detail.portions;
    recipients.push({
      uid,
      portions: detail.portions,
      memberType: detail.memberType,
      labels: detail.labels,
      rankLevel,
    });
  }

  const perPortionValue = totalPortions > 0 ? toMoney(bonusPool / totalPortions) : 0;
  for (const row of recipients) {
    row.shareAmount = toMoney(perPortionValue * Number(row.portions || 0));
  }

  return {
    periodScope: 'annual',
    year,
    periodLabel: `Year ${year}`,
    totalNetSales,
    bonusPool,
    totalPortions,
    perPortionValue,
    totalDistributed: toMoney(recipients.reduce((sum, row) => sum + Number(row.shareAmount || 0), 0)),
    recipientCount: recipients.length,
    canDistribute: true,
    recipients,
  };
}

async function distributeGlobalBonus(yearInput, processId = 'system') {
  await ensureGlobalBonusTables();
  const summary = await calculateGlobalBonus(yearInput);

  await pool.query(
    `INSERT INTO globalbonus_poolstab
      (period_scope, period_month, period_year, total_net_sales, bonus_pool, total_portions, per_portion_value,
       status, distributed_date, created_date, processid)
     VALUES ('annual', 0, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)
     ON DUPLICATE KEY UPDATE
       total_net_sales = VALUES(total_net_sales),
       bonus_pool = VALUES(bonus_pool),
       total_portions = VALUES(total_portions),
       per_portion_value = VALUES(per_portion_value),
       status = 1,
       distributed_date = NOW(),
       processid = VALUES(processid)`,
    [
      summary.year,
      summary.totalNetSales,
      summary.bonusPool,
      summary.totalPortions,
      summary.perPortionValue,
      processId,
    ]
  );

  await pool.query(
    `DELETE FROM globalbonus_membertab
     WHERE period_scope = 'annual' AND period_year = ? AND period_month = 0`,
    [summary.year]
  );

  for (const row of summary.recipients) {
    await pool.query(
      `INSERT INTO globalbonus_membertab
        (uid, period_scope, period_month, period_year, member_type, portions, share_amount, distributed_date, processid)
       VALUES (?, 'annual', 0, ?, ?, ?, ?, NOW(), ?)`,
      [
        row.uid,
        summary.year,
        row.memberType,
        row.portions,
        row.shareAmount,
        processId,
      ]
    );
  }

  return summary;
}

async function getPoolRecord(yearInput) {
  await ensureGlobalBonusTables();
  const year = normalizeAnnualYear(yearInput);
  const [rows] = await pool.query(
    `SELECT period_year, total_net_sales, bonus_pool, total_portions,
            per_portion_value, status, distributed_date, created_date
     FROM globalbonus_poolstab
     WHERE period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0
     LIMIT 1`,
    [year]
  );

  if (!rows.length) return null;
  const row = rows[0];
  return {
    periodScope: 'annual',
    year: Number(row.period_year),
    periodLabel: `Year ${Number(row.period_year)}`,
    totalNetSales: toMoney(row.total_net_sales),
    bonusPool: toMoney(row.bonus_pool),
    totalPortions: Number(row.total_portions || 0),
    perPortionValue: toMoney(row.per_portion_value),
    status: Number(row.status || 0),
    distributedDate: row.distributed_date,
    createdDate: row.created_date,
  };
}

async function getLatestPoolRecord() {
  await ensureGlobalBonusTables();
  const [rows] = await pool.query(
    `SELECT period_year, total_net_sales, bonus_pool, total_portions,
            per_portion_value, status, distributed_date, created_date
     FROM globalbonus_poolstab
     WHERE period_scope = 'annual' AND COALESCE(period_month, 0) = 0
     ORDER BY period_year DESC
     LIMIT 1`
  );

  if (!rows.length) return null;
  const row = rows[0];
  return {
    periodScope: 'annual',
    year: Number(row.period_year),
    periodLabel: `Year ${Number(row.period_year)}`,
    totalNetSales: toMoney(row.total_net_sales),
    bonusPool: toMoney(row.bonus_pool),
    totalPortions: Number(row.total_portions || 0),
    perPortionValue: toMoney(row.per_portion_value),
    status: Number(row.status || 0),
    distributedDate: row.distributed_date,
    createdDate: row.created_date,
  };
}

async function getMemberGlobalBonus(uid, yearInput) {
  await ensureGlobalBonusTables();
  const year = normalizeAnnualYear(yearInput);
  const userId = Number(uid);

  const [memberRows, rankMap, poolRecord] = await Promise.all([
    pool.query(
      `SELECT uid, currentaccttype, stockistid
       FROM usertab
       WHERE uid = ?
       LIMIT 1`,
      [userId]
    ),
    getRankingMap(),
    getPoolRecord(year),
  ]);

  const member = memberRows[0][0];
  if (!member) {
    return {
      periodScope: 'annual',
      year,
      periodLabel: `Year ${year}`,
      eligible: false,
      portions: 0,
      memberType: null,
      labels: [],
      projectedShare: 0,
      distributedShare: 0,
      pool: poolRecord,
    };
  }

  const detail = getPortionDetails(member, rankMap.get(userId) || 0);
  const [shareRows] = await pool.query(
    `SELECT share_amount, portions, member_type, distributed_date
     FROM globalbonus_membertab
     WHERE uid = ? AND period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0
     LIMIT 1`,
    [userId, year]
  );

  const shareRow = shareRows[0] || null;
  const distributedShare = shareRow ? toMoney(shareRow.share_amount) : 0;
  const effectivePortions = shareRow ? Number(shareRow.portions || detail.portions || 0) : detail.portions;
  const projectedShare = (poolRecord && !shareRow)
    ? toMoney(Number(poolRecord.perPortionValue || 0) * Number(detail.portions || 0))
    : distributedShare;

  const [latestShareRows] = await pool.query(
    `SELECT period_year, share_amount, distributed_date
     FROM globalbonus_membertab
     WHERE uid = ? AND period_scope = 'annual' AND COALESCE(period_month, 0) = 0
     ORDER BY period_year DESC
     LIMIT 1`,
    [userId]
  );

  const latestShare = latestShareRows[0]
    ? {
      year: Number(latestShareRows[0].period_year),
      periodLabel: `Year ${Number(latestShareRows[0].period_year)}`,
      shareAmount: toMoney(latestShareRows[0].share_amount),
      distributedDate: latestShareRows[0].distributed_date,
    }
    : null;

  const visibility = buildGlobalBonusVisibility({
    eligible: detail.portions > 0,
    labels: detail.labels,
  });

  return {
    periodScope: 'annual',
    year,
    periodLabel: `Year ${year}`,
    eligible: detail.portions > 0,
    portions: effectivePortions,
    memberType: shareRow?.member_type || detail.memberType,
    labels: detail.labels,
    projectedShare,
    distributedShare,
    distributedDate: shareRow?.distributed_date || null,
    pool: poolRecord,
    latestShare,
    ...visibility,
  };
}

async function getGlobalBonusReport(yearInput, pageInput = 1, perPageInput = 30) {
  await ensureGlobalBonusTables();
  const year = normalizeAnnualYear(yearInput);
  const page = Math.max(1, Number(pageInput) || 1);
  const perPage = Math.min(200, Math.max(1, Number(perPageInput) || 30));
  const offset = (page - 1) * perPage;

  const [poolRecord, preview, countRows, rows] = await Promise.all([
    getPoolRecord(year),
    calculateGlobalBonus(year).catch((error) => {
      if (String(error.message || '').includes('fully completed year')) {
        return {
          periodScope: 'annual',
          year,
          periodLabel: `Year ${year}`,
          totalNetSales: 0,
          bonusPool: 0,
          totalPortions: 0,
          perPortionValue: 0,
          totalDistributed: 0,
          recipientCount: 0,
          canDistribute: false,
          blockedReason: error.message,
          recipients: [],
        };
      }
      throw error;
    }),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM globalbonus_membertab
       WHERE period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0`,
      [year]
    ),
    pool.query(
      `SELECT g.uid, g.member_type, g.portions, g.share_amount, g.distributed_date,
              m.username, m.firstname, m.lastname
       FROM globalbonus_membertab g
       LEFT JOIN memberstab m ON m.uid = g.uid
       WHERE g.period_scope = 'annual' AND g.period_year = ? AND COALESCE(g.period_month, 0) = 0
       ORDER BY g.share_amount DESC, g.uid ASC
       LIMIT ?, ?`,
      [year, offset, perPage]
    ),
  ]);

  const total = Number(countRows[0][0]?.total || 0);
  return {
    periodScope: 'annual',
    year,
    periodLabel: `Year ${year}`,
    pool: poolRecord,
    preview,
    distributedRecipients: rows[0].map((row) => ({
      uid: Number(row.uid),
      username: row.username,
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
      memberType: row.member_type,
      portions: Number(row.portions || 0),
      shareAmount: toMoney(row.share_amount),
      distributedDate: row.distributed_date,
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    canDistribute: year < getCurrentYear(),
  };
}

module.exports = {
  ensureGlobalBonusTables,
  calculateGlobalBonus,
  distributeGlobalBonus,
  getMemberGlobalBonus,
  getGlobalBonusReport,
  getPoolRecord,
  getLatestPoolRecord,
  normalizeAnnualYear,
  assertClosedDistributionYear,
  getLastClosedYear,
  buildGlobalBonusVisibility,
};
