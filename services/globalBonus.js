/**
 * Global Bonus service (DOC2 §4.3)
 * Pool = 2% of monthly net sales, distributed by member portions.
 */
const { pool } = require('../config/database');

const STOCKIST_PORTIONS = {
  2: { points: 1, label: 'Mobile Stockist' },
  3: { points: 2, label: 'City Stockist' },
  4: { points: 3, label: 'Provincial Stockist' },
};

function toMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function periodNow() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function normalizePeriod(month, year) {
  const fallback = periodNow();
  const m = Number(month) || fallback.month;
  const y = Number(year) || fallback.year;
  return {
    month: Math.min(12, Math.max(1, m)),
    year: Math.max(2000, y),
  };
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
  return new Set(rows.map(r => r.name));
}

async function ensureGlobalBonusTables() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS globalbonus_poolstab (
      id INT NOT NULL AUTO_INCREMENT,
      period_month INT NOT NULL,
      period_year INT NOT NULL,
      total_net_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
      bonus_pool DECIMAL(14,2) NOT NULL DEFAULT 0,
      total_portions INT NOT NULL DEFAULT 0,
      per_portion_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      status INT NOT NULL DEFAULT 0,
      distributed_date DATETIME DEFAULT NULL,
      created_date DATETIME DEFAULT NULL,
      processid VARCHAR(30) DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_period (period_month, period_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS globalbonus_membertab (
      id INT NOT NULL AUTO_INCREMENT,
      uid INT NOT NULL,
      period_month INT NOT NULL,
      period_year INT NOT NULL,
      member_type VARCHAR(60) DEFAULT NULL,
      portions FLOAT NOT NULL DEFAULT 0,
      share_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      distributed_date DATETIME DEFAULT NULL,
      processid VARCHAR(30) DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_uid_period (uid, period_month, period_year),
      KEY idx_period (period_month, period_year),
      KEY idx_uid (uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1`
  );
}

async function getRankingMap() {
  const exists = await tableExists('rankingstab');
  if (!exists) return new Map();

  const cols = await getTableColumns('rankingstab');
  const rankColumn = cols.has('rank_level') ? 'rank_level' : (cols.has('current_rank') ? 'current_rank' : null);
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

function getPortionDetails(userRow, rankLevel) {
  const labels = [];
  let portions = 0;

  if (Number(userRow.currentaccttype) === 60) {
    portions += 1;
    labels.push('Diamond');
  }

  if (Number(rankLevel || 0) >= 3) {
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

async function getMonthlyNetSales(month, year) {
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(productamount), 0) AS totalNetSales
     FROM codestab
     WHERE codestatus = 2
       AND producttype >= 10 AND producttype <= 90
       AND MONTH(dateused) = ?
       AND YEAR(dateused) = ?`,
    [month, year]
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

async function calculateGlobalBonus(monthInput, yearInput) {
  const { month, year } = normalizePeriod(monthInput, yearInput);
  const [totalNetSales, rankMap, members] = await Promise.all([
    getMonthlyNetSales(month, year),
    getRankingMap(),
    getEligibleMemberRows(),
  ]);

  const bonusPool = toMoney(totalNetSales * 0.02);

  const recipients = [];
  let totalPortions = 0;

  for (const m of members) {
    const uid = Number(m.uid);
    const rankLevel = rankMap.get(uid) || 0;
    const detail = getPortionDetails(m, rankLevel);
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

  const totalDistributed = toMoney(recipients.reduce((sum, r) => sum + Number(r.shareAmount || 0), 0));

  return {
    month,
    year,
    totalNetSales,
    bonusPool,
    totalPortions,
    perPortionValue,
    totalDistributed,
    recipientCount: recipients.length,
    recipients,
  };
}

async function distributeGlobalBonus(monthInput, yearInput, processId = 'system') {
  await ensureGlobalBonusTables();
  const summary = await calculateGlobalBonus(monthInput, yearInput);

  await pool.query(
    `INSERT INTO globalbonus_poolstab
      (period_month, period_year, total_net_sales, bonus_pool, total_portions, per_portion_value,
       status, distributed_date, created_date, processid)
     VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)
     ON DUPLICATE KEY UPDATE
       total_net_sales = VALUES(total_net_sales),
       bonus_pool = VALUES(bonus_pool),
       total_portions = VALUES(total_portions),
       per_portion_value = VALUES(per_portion_value),
       status = 1,
       distributed_date = NOW(),
       processid = VALUES(processid)`,
    [
      summary.month,
      summary.year,
      summary.totalNetSales,
      summary.bonusPool,
      summary.totalPortions,
      summary.perPortionValue,
      processId,
    ]
  );

  await pool.query(
    'DELETE FROM globalbonus_membertab WHERE period_month = ? AND period_year = ?',
    [summary.month, summary.year]
  );

  for (const row of summary.recipients) {
    await pool.query(
      `INSERT INTO globalbonus_membertab
        (uid, period_month, period_year, member_type, portions, share_amount, distributed_date, processid)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        row.uid,
        summary.month,
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

async function getPoolRecord(monthInput, yearInput) {
  const { month, year } = normalizePeriod(monthInput, yearInput);
  const [rows] = await pool.query(
    `SELECT period_month, period_year, total_net_sales, bonus_pool, total_portions,
            per_portion_value, status, distributed_date, created_date
     FROM globalbonus_poolstab
     WHERE period_month = ? AND period_year = ?
     LIMIT 1`,
    [month, year]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    month: Number(row.period_month),
    year: Number(row.period_year),
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
  const [rows] = await pool.query(
    `SELECT period_month, period_year, total_net_sales, bonus_pool, total_portions,
            per_portion_value, status, distributed_date, created_date
     FROM globalbonus_poolstab
     ORDER BY period_year DESC, period_month DESC
     LIMIT 1`
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    month: Number(row.period_month),
    year: Number(row.period_year),
    totalNetSales: toMoney(row.total_net_sales),
    bonusPool: toMoney(row.bonus_pool),
    totalPortions: Number(row.total_portions || 0),
    perPortionValue: toMoney(row.per_portion_value),
    status: Number(row.status || 0),
    distributedDate: row.distributed_date,
    createdDate: row.created_date,
  };
}

async function getMemberGlobalBonus(uid, monthInput, yearInput) {
  await ensureGlobalBonusTables();

  const { month, year } = normalizePeriod(monthInput, yearInput);
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
    getPoolRecord(month, year),
  ]);

  const member = memberRows[0][0];
  if (!member) {
    return {
      month,
      year,
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
     WHERE uid = ? AND period_month = ? AND period_year = ?
     LIMIT 1`,
    [userId, month, year]
  );

  const shareRow = shareRows[0] || null;
  const distributedShare = shareRow ? toMoney(shareRow.share_amount) : 0;
  const effectivePortions = shareRow ? Number(shareRow.portions || detail.portions || 0) : detail.portions;

  const projectedShare = (poolRecord && !shareRow)
    ? toMoney(Number(poolRecord.perPortionValue || 0) * Number(detail.portions || 0))
    : distributedShare;

  const [latestShareRows] = await pool.query(
    `SELECT period_month, period_year, share_amount, distributed_date
     FROM globalbonus_membertab
     WHERE uid = ?
     ORDER BY period_year DESC, period_month DESC
     LIMIT 1`,
    [userId]
  );

  const latestShare = latestShareRows[0]
    ? {
      month: Number(latestShareRows[0].period_month),
      year: Number(latestShareRows[0].period_year),
      shareAmount: toMoney(latestShareRows[0].share_amount),
      distributedDate: latestShareRows[0].distributed_date,
    }
    : null;

  return {
    month,
    year,
    eligible: detail.portions > 0,
    portions: effectivePortions,
    memberType: shareRow?.member_type || detail.memberType,
    labels: detail.labels,
    projectedShare,
    distributedShare,
    distributedDate: shareRow?.distributed_date || null,
    pool: poolRecord,
    latestShare,
  };
}

async function getGlobalBonusReport(monthInput, yearInput, pageInput = 1, perPageInput = 30) {
  await ensureGlobalBonusTables();

  const { month, year } = normalizePeriod(monthInput, yearInput);
  const page = Math.max(1, Number(pageInput) || 1);
  const perPage = Math.min(200, Math.max(1, Number(perPageInput) || 30));
  const offset = (page - 1) * perPage;

  const [poolRecord, preview, countRows, rows] = await Promise.all([
    getPoolRecord(month, year),
    calculateGlobalBonus(month, year),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM globalbonus_membertab
       WHERE period_month = ? AND period_year = ?`,
      [month, year]
    ),
    pool.query(
      `SELECT g.uid, g.member_type, g.portions, g.share_amount, g.distributed_date,
              m.username, m.firstname, m.lastname
       FROM globalbonus_membertab g
       LEFT JOIN memberstab m ON m.uid = g.uid
       WHERE g.period_month = ? AND g.period_year = ?
       ORDER BY g.share_amount DESC, g.uid ASC
       LIMIT ?, ?`,
      [month, year, offset, perPage]
    ),
  ]);

  const total = Number(countRows[0][0]?.total || 0);
  const recipients = rows[0].map(r => ({
    uid: Number(r.uid),
    username: r.username,
    fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim(),
    memberType: r.member_type,
    portions: Number(r.portions || 0),
    shareAmount: toMoney(r.share_amount),
    distributedDate: r.distributed_date,
  }));

  return {
    month,
    year,
    pool: poolRecord,
    preview,
    distributedRecipients: recipients,
    total,
    page,
    totalPages: Math.ceil(total / perPage),
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
  normalizePeriod,
};
