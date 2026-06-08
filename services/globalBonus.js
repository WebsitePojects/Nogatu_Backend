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
    `CREATE TABLE IF NOT EXISTS globalbonus_override_tab (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      uid INT NOT NULL,
      period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
      period_month INT NOT NULL DEFAULT 0,
      period_year INT NOT NULL,
      status INT NOT NULL DEFAULT 1,
      manual_entry TINYINT(1) NOT NULL DEFAULT 0,
      portions FLOAT NOT NULL DEFAULT 0,
      member_type VARCHAR(60) DEFAULT NULL,
      created_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
      updated_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      processid VARCHAR(30) DEFAULT NULL,
      UNIQUE KEY uq_globalbonus_override_period_member (uid, period_scope, period_month, period_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

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

const GLOBAL_BONUS_OVERRIDE_STATUS = {
  ACTIVE: 1,
  REMOVED: 2,
  FROZEN: 3,
};

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
    `SELECT u.uid, u.currentaccttype, u.stockistid,
            m.username, m.firstname, m.lastname
     FROM usertab
     LEFT JOIN memberstab m ON m.uid = u.uid
     WHERE u.uid = u.mainid`
  );
  return rows;
}

async function getGlobalBonusOverrides(yearInput) {
  await ensureGlobalBonusTables();
  const year = normalizeAnnualYear(yearInput);
  const [rows] = await pool.query(
    `SELECT o.id, o.uid, o.period_year, o.status, o.manual_entry, o.portions, o.member_type,
            o.created_date, o.updated_date, o.processid,
            u.currentaccttype, u.stockistid,
            m.username, m.firstname, m.lastname
       FROM globalbonus_override_tab o
       LEFT JOIN usertab u ON u.uid = o.uid
       LEFT JOIN memberstab m ON m.uid = o.uid
      WHERE o.period_scope = 'annual' AND o.period_year = ? AND COALESCE(o.period_month, 0) = 0
      ORDER BY o.updated_date DESC, o.id DESC`,
    [year]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    uid: Number(row.uid),
    year: Number(row.period_year),
    status: Number(row.status || 0),
    manualEntry: Number(row.manual_entry || 0) === 1,
    portions: Number(row.portions || 0),
    memberType: row.member_type || null,
    createdDate: row.created_date,
    updatedDate: row.updated_date,
    processId: row.processid || null,
    currentaccttype: Number(row.currentaccttype || 0),
    stockistid: Number(row.stockistid || 0),
    username: row.username || '',
    fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
  }));
}

function mapRecipientForResponse(row, extra = {}) {
  return {
    uid: Number(row.uid),
    username: row.username || '',
    fullname: row.fullname || '',
    memberType: row.memberType || null,
    portions: Number(row.portions || 0),
    shareAmount: toMoney(row.shareAmount || 0),
    labels: Array.isArray(row.labels) ? row.labels : [],
    source: row.source || 'qualified',
    adminState: extra.adminState || 'active',
    adminStatus: extra.adminStatus || GLOBAL_BONUS_OVERRIDE_STATUS.ACTIVE,
    manualEntry: Boolean(extra.manualEntry),
    distributedDate: row.distributedDate || null,
  };
}

async function calculateGlobalBonus(yearInput, options = {}) {
  await ensureGlobalBonusTables();
  const { includeManagement = false } = options;
  const year = assertClosedDistributionYear(yearInput);
  const [totalNetSales, rankMap, members, overrides] = await Promise.all([
    getAnnualNetSales(year),
    getRankingMap(),
    getEligibleMemberRows(),
    getGlobalBonusOverrides(year),
  ]);

  const bonusPool = toMoney(totalNetSales * 0.02);
  const recipientMap = new Map();
  const excludedMap = new Map();

  for (const member of members) {
    const uid = Number(member.uid);
    const rankLevel = rankMap.get(uid) || 0;
    const detail = getPortionDetails(member, rankLevel);
    if (detail.portions <= 0) continue;

    recipientMap.set(uid, {
      uid,
      username: member.username || '',
      fullname: `${member.firstname || ''} ${member.lastname || ''}`.trim(),
      portions: detail.portions,
      memberType: detail.memberType,
      labels: detail.labels,
      rankLevel,
      source: 'qualified',
    });
  }

  for (const override of overrides) {
    const baseCandidate = recipientMap.get(override.uid);
    const effectiveLabels = baseCandidate?.labels || [];
    const effectiveMemberType = override.memberType || baseCandidate?.memberType || 'Manual Include';

    if (override.manualEntry) {
      if (override.status === GLOBAL_BONUS_OVERRIDE_STATUS.ACTIVE) {
        recipientMap.set(override.uid, {
          uid: override.uid,
          username: override.username || baseCandidate?.username || '',
          fullname: override.fullname || baseCandidate?.fullname || '',
          portions: Math.max(0, Number(override.portions || 0)),
          memberType: effectiveMemberType,
          labels: effectiveLabels.length ? effectiveLabels : ['Manual Include'],
          rankLevel: baseCandidate?.rankLevel || 0,
          source: 'manual',
        });
      } else {
        recipientMap.delete(override.uid);
        excludedMap.set(override.uid, {
          uid: override.uid,
          username: override.username || baseCandidate?.username || '',
          fullname: override.fullname || baseCandidate?.fullname || '',
          portions: Number(override.portions || baseCandidate?.portions || 0),
          memberType: effectiveMemberType,
          labels: effectiveLabels.length ? effectiveLabels : ['Manual Include'],
          source: 'manual',
          adminState: override.status === GLOBAL_BONUS_OVERRIDE_STATUS.FROZEN ? 'frozen' : 'removed',
          adminStatus: override.status,
          manualEntry: true,
        });
      }
      continue;
    }

    if (override.status === GLOBAL_BONUS_OVERRIDE_STATUS.REMOVED || override.status === GLOBAL_BONUS_OVERRIDE_STATUS.FROZEN) {
      const previous = recipientMap.get(override.uid) || {
        uid: override.uid,
        username: override.username || '',
        fullname: override.fullname || '',
        portions: Number(override.portions || 0),
        memberType: effectiveMemberType,
        labels: effectiveLabels,
        source: 'qualified',
      };
      recipientMap.delete(override.uid);
      excludedMap.set(override.uid, {
        ...previous,
        adminState: override.status === GLOBAL_BONUS_OVERRIDE_STATUS.FROZEN ? 'frozen' : 'removed',
        adminStatus: override.status,
        manualEntry: false,
      });
    } else if (baseCandidate) {
      recipientMap.set(override.uid, {
        ...baseCandidate,
        portions: Number(override.portions || baseCandidate.portions || 0),
        memberType: effectiveMemberType,
      });
    }
  }

  const recipients = Array.from(recipientMap.values());
  let totalPortions = recipients.reduce((sum, row) => sum + Number(row.portions || 0), 0);
  const perPortionValue = totalPortions > 0 ? toMoney(bonusPool / totalPortions) : 0;
  for (const row of recipients) {
    row.shareAmount = toMoney(perPortionValue * Number(row.portions || 0));
  }

  const managementRows = includeManagement
    ? [
      ...recipients.map((row) => mapRecipientForResponse(row, {
        adminState: 'active',
        adminStatus: GLOBAL_BONUS_OVERRIDE_STATUS.ACTIVE,
        manualEntry: row.source === 'manual',
      })),
      ...Array.from(excludedMap.values()).map((row) => mapRecipientForResponse(row, row)),
    ].sort((a, b) => {
      if (a.adminState !== b.adminState) return a.adminState.localeCompare(b.adminState);
      return (a.fullname || a.username || '').localeCompare(b.fullname || b.username || '');
    })
    : [];

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
    managementRows,
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
    calculateGlobalBonus(year, { includeManagement: true }).catch((error) => {
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
          managementRows: [],
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
    managementRecipients: preview.managementRows || [],
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    canDistribute: year < getCurrentYear(),
  };
}

async function getGlobalBonusMemberByUsername(username) {
  const trimmed = String(username || '').trim();
  if (!trimmed) {
    throw new Error('Username is required.');
  }

  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype, u.stockistid, m.username, m.firstname, m.lastname
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = u.mainid AND m.username = ?
      LIMIT 1`,
    [trimmed]
  );

  if (!rows.length) {
    throw new Error('Member not found.');
  }

  const row = rows[0];
  return {
    uid: Number(row.uid),
    currentaccttype: Number(row.currentaccttype || 0),
    stockistid: Number(row.stockistid || 0),
    username: row.username || '',
    fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
  };
}

async function getGlobalBonusMemberByUid(uid) {
  const memberUid = Number(uid);
  if (!memberUid) {
    throw new Error('Member uid is required.');
  }

  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype, u.stockistid, m.username, m.firstname, m.lastname
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = u.mainid AND u.uid = ?
      LIMIT 1`,
    [memberUid]
  );

  if (!rows.length) {
    throw new Error('Member not found.');
  }

  const row = rows[0];
  return {
    uid: Number(row.uid),
    currentaccttype: Number(row.currentaccttype || 0),
    stockistid: Number(row.stockistid || 0),
    username: row.username || '',
    fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
  };
}

async function searchGlobalBonusMembers(query, yearInput) {
  const year = assertClosedDistributionYear(yearInput);
  const term = `%${String(query || '').trim()}%`;
  if (term === '%%') return [];

  const rankMap = await getRankingMap();
  const [rows] = await pool.query(
    `SELECT u.uid, u.currentaccttype, u.stockistid, m.username, m.firstname, m.lastname
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = u.mainid
        AND (m.username LIKE ? OR CONCAT_WS(' ', m.firstname, m.lastname) LIKE ?)
      ORDER BY m.username ASC
      LIMIT 20`,
    [term, term]
  );

  const overrides = await getGlobalBonusOverrides(year);
  const overrideMap = new Map(overrides.map((row) => [row.uid, row]));

  return rows.map((row) => {
    const uid = Number(row.uid);
    const detail = getPortionDetails(row, rankMap.get(uid) || 0);
    const override = overrideMap.get(uid);
    return {
      uid,
      username: row.username || '',
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
      suggestedPortions: detail.portions,
      suggestedMemberType: detail.memberType,
      labels: detail.labels,
      isQualified: detail.portions > 0,
      overrideStatus: override ? Number(override.status || 0) : null,
      manualEntry: override ? Boolean(override.manualEntry) : false,
    };
  });
}

async function addGlobalBonusMember(yearInput, payload = {}, processId = 'admin') {
  await ensureGlobalBonusTables();
  const year = assertClosedDistributionYear(yearInput);
  const member = payload.uid
    ? await getGlobalBonusMemberByUid(payload.uid)
    : await getGlobalBonusMemberByUsername(payload.username);

  const portions = Math.max(1, Number(payload.portions || 1));
  const memberType = String(payload.memberType || 'Manual Include').trim().slice(0, 60) || 'Manual Include';

  await pool.query(
    `INSERT INTO globalbonus_override_tab
      (uid, period_scope, period_month, period_year, status, manual_entry, portions, member_type, processid)
     VALUES (?, 'annual', 0, ?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      manual_entry = 1,
      portions = VALUES(portions),
      member_type = VALUES(member_type),
      processid = VALUES(processid)`,
    [
      member.uid,
      year,
      GLOBAL_BONUS_OVERRIDE_STATUS.ACTIVE,
      portions,
      memberType,
      processId,
    ]
  );

  return { year, uid: member.uid, username: member.username, portions, memberType };
}

async function removeGlobalBonusMember(yearInput, uid, processId = 'admin') {
  await ensureGlobalBonusTables();
  const year = assertClosedDistributionYear(yearInput);
  const memberUid = Number(uid);
  if (!memberUid) throw new Error('Member uid is required.');

  const overrides = await getGlobalBonusOverrides(year);
  const existing = overrides.find((row) => row.uid === memberUid);
  if (existing?.manualEntry) {
    await pool.query(
      `DELETE FROM globalbonus_override_tab
       WHERE uid = ? AND period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0`,
      [memberUid, year]
    );
    return { year, uid: memberUid, action: 'deleted-manual-entry' };
  }

  const rankMap = await getRankingMap();
  const member = await getGlobalBonusMemberByUid(memberUid);
  const detail = getPortionDetails(member, rankMap.get(memberUid) || 0);

  await pool.query(
    `INSERT INTO globalbonus_override_tab
      (uid, period_scope, period_month, period_year, status, manual_entry, portions, member_type, processid)
     VALUES (?, 'annual', 0, ?, ?, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      manual_entry = 0,
      portions = VALUES(portions),
      member_type = VALUES(member_type),
      processid = VALUES(processid)`,
    [
      memberUid,
      year,
      GLOBAL_BONUS_OVERRIDE_STATUS.REMOVED,
      Math.max(0, Number(detail.portions || 0)),
      detail.memberType,
      processId,
    ]
  );

  return { year, uid: memberUid, action: 'removed' };
}

async function freezeGlobalBonusMember(yearInput, uid, processId = 'admin') {
  await ensureGlobalBonusTables();
  const year = assertClosedDistributionYear(yearInput);
  const memberUid = Number(uid);
  if (!memberUid) throw new Error('Member uid is required.');

  const overrides = await getGlobalBonusOverrides(year);
  const existing = overrides.find((row) => row.uid === memberUid);
  if (existing?.manualEntry) {
    await pool.query(
      `UPDATE globalbonus_override_tab
          SET status = ?, processid = ?
        WHERE uid = ? AND period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0`,
      [GLOBAL_BONUS_OVERRIDE_STATUS.FROZEN, processId, memberUid, year]
    );
    return { year, uid: memberUid, action: 'frozen-manual-entry' };
  }

  const rankMap = await getRankingMap();
  const member = await getGlobalBonusMemberByUid(memberUid);
  const detail = getPortionDetails(member, rankMap.get(memberUid) || 0);

  await pool.query(
    `INSERT INTO globalbonus_override_tab
      (uid, period_scope, period_month, period_year, status, manual_entry, portions, member_type, processid)
     VALUES (?, 'annual', 0, ?, ?, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      manual_entry = 0,
      portions = VALUES(portions),
      member_type = VALUES(member_type),
      processid = VALUES(processid)`,
    [
      memberUid,
      year,
      GLOBAL_BONUS_OVERRIDE_STATUS.FROZEN,
      Math.max(0, Number(detail.portions || 0)),
      detail.memberType,
      processId,
    ]
  );

  return { year, uid: memberUid, action: 'frozen' };
}

async function unfreezeGlobalBonusMember(yearInput, uid, processId = 'admin') {
  await ensureGlobalBonusTables();
  const year = assertClosedDistributionYear(yearInput);
  const memberUid = Number(uid);
  if (!memberUid) throw new Error('Member uid is required.');

  const overrides = await getGlobalBonusOverrides(year);
  const existing = overrides.find((row) => row.uid === memberUid);
  if (!existing) {
    return { year, uid: memberUid, action: 'noop' };
  }

  if (existing.manualEntry) {
    await pool.query(
      `UPDATE globalbonus_override_tab
          SET status = ?, processid = ?
        WHERE uid = ? AND period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0`,
      [GLOBAL_BONUS_OVERRIDE_STATUS.ACTIVE, processId, memberUid, year]
    );
    return { year, uid: memberUid, action: 'unfrozen-manual-entry' };
  }

  await pool.query(
    `DELETE FROM globalbonus_override_tab
      WHERE uid = ? AND period_scope = 'annual' AND period_year = ? AND COALESCE(period_month, 0) = 0`,
    [memberUid, year]
  );
  return { year, uid: memberUid, action: 'unfrozen' };
}

module.exports = {
  ensureGlobalBonusTables,
  calculateGlobalBonus,
  distributeGlobalBonus,
  getMemberGlobalBonus,
  getGlobalBonusReport,
  getPoolRecord,
  getLatestPoolRecord,
  getGlobalBonusOverrides,
  searchGlobalBonusMembers,
  addGlobalBonusMember,
  removeGlobalBonusMember,
  freezeGlobalBonusMember,
  unfreezeGlobalBonusMember,
  normalizeAnnualYear,
  assertClosedDistributionYear,
  getLastClosedYear,
  buildGlobalBonusVisibility,
};
