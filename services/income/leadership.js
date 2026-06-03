/**
 * Leadership Bonus Calculation
 * 1:1 port baseline of PHP income-leadership-2026-fnc.php, extended with
 * traceability rows for member/admin audit views.
 */
const { pool } = require('../../config/database');

function toNumber(value) {
  return Number(value || 0);
}

function rateForLeadershipLevel(level) {
  const numericLevel = toNumber(level);
  if (numericLevel === 1) return 0.05;
  if (numericLevel === 2) return 0.02;
  if (numericLevel >= 3 && numericLevel <= 5) return 0.01;
  return 0;
}

function summarizeLeadershipTraceability(rows = []) {
  const normalizedRows = rows
    .map((row) => {
      const rate = rateForLeadershipLevel(row.level);
      return {
        uid: toNumber(row.uid),
        username: row.username || null,
        fullName: row.fullName || row.fullname || row.name || row.username || `UID ${row.uid}`,
        level: toNumber(row.level),
        rate,
        ratePercent: rate * 100,
        pairingIncome: toNumber(row.pairingIncome ?? row.income),
        leadershipBonus: toNumber(row.pairingIncome ?? row.income) * rate,
        directReferralCount: toNumber(row.directReferralCount),
      };
    })
    .filter((row) => row.level > 0 && row.rate > 0 && row.leadershipBonus > 0);

  return {
    rows: normalizedRows,
    totalSources: normalizedRows.length,
    totalBonus: normalizedRows.reduce((sum, row) => sum + row.leadershipBonus, 0),
    byLevel: {
      level1: normalizedRows.filter((row) => row.level === 1).reduce((sum, row) => sum + row.leadershipBonus, 0),
      level2: normalizedRows.filter((row) => row.level === 2).reduce((sum, row) => sum + row.leadershipBonus, 0),
      level35: normalizedRows.filter((row) => row.level >= 3 && row.level <= 5).reduce((sum, row) => sum + row.leadershipBonus, 0),
    },
  };
}

async function collectLeadershipTraceability(parentUid, level, conn, results) {
  if (level > 5) return;

  const [rows] = await conn.query(
    `SELECT
        u.uid,
        m.username,
        m.firstname,
        m.lastname,
        COALESCE(p.ttlincome2, 0) AS pairingIncome,
        (
          SELECT COUNT(*)
          FROM usertab dr
          WHERE dr.drefid = u.uid
        ) AS directReferralCount
     FROM usertab u
     LEFT JOIN memberstab m ON m.uid = u.uid
     LEFT JOIN payouttotaltab p ON p.uid = u.uid
     WHERE u.drefid = ?
     ORDER BY u.uid ASC`,
    [parentUid]
  );

  for (const row of rows) {
    results.push({
      uid: toNumber(row.uid),
      username: row.username || null,
      fullName: `${row.firstname || ''} ${row.lastname || ''}`.trim() || row.username || `UID ${row.uid}`,
      level,
      pairingIncome: toNumber(row.pairingIncome),
      directReferralCount: toNumber(row.directReferralCount),
    });

    await collectLeadershipTraceability(row.uid, level + 1, conn, results);
  }
}

async function getLeadershipTraceability(uid, conn = pool) {
  const rows = [];
  await collectLeadershipTraceability(toNumber(uid), 1, conn, rows);
  return summarizeLeadershipTraceability(rows);
}

async function getLeadershipBonus(uid, conn = pool) {
  const trace = await getLeadershipTraceability(uid, conn);
  return trace.totalBonus;
}

module.exports = {
  rateForLeadershipLevel,
  summarizeLeadershipTraceability,
  getLeadershipTraceability,
  getLeadershipBonus,
};
