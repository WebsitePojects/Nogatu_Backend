const { pool } = require('../config/database');
const { countsForPairingSource, getEffectiveAccountState, getAccountStateLabel } = require('./accountState');

function normalizeOwnerLeg(rawValue) {
  const key = String(rawValue || '').trim().toLowerCase();
  if (key === 'left' || key === '1') return 'left';
  if (key === 'right' || key === '2') return 'right';
  return null;
}

function formatDirectRow(row) {
  return {
    uid: Number(row.uid || 0),
    username: row.username || null,
    fullName: row.fullName || row.full_name || row.username || `UID ${row.uid}`,
    ownerLeg: normalizeOwnerLeg(row.ownerLeg || row.owner_leg || row.leg),
    accountState: getAccountStateLabel(row),
    currentAcctType: Number(row.currentaccttype || row.accttype || 0),
    codeid: Number(row.codeid || 0),
  };
}

function summarizeQualifiedDirectLegs(ownerUid, rows = []) {
  const normalizedOwnerUid = Number(ownerUid || 0);
  const qualifyingDirects = {
    left: [],
    right: [],
  };

  for (const row of rows) {
    const ownerLeg = normalizeOwnerLeg(row.ownerLeg || row.owner_leg || row.leg);
    if (!ownerLeg) continue;
    if (Number(row.drefid || 0) !== normalizedOwnerUid) continue;
    if (!countsForPairingSource(row)) continue;
    qualifyingDirects[ownerLeg].push(formatDirectRow({ ...row, ownerLeg }));
  }

  const leftQualifiedCount = qualifyingDirects.left.length;
  const rightQualifiedCount = qualifyingDirects.right.length;
  const missingLegs = [
    ...(leftQualifiedCount > 0 ? [] : ['left']),
    ...(rightQualifiedCount > 0 ? [] : ['right']),
  ];
  const canEarnPairing = missingLegs.length === 0;

  return {
    canEarnPairing,
    leftQualifiedCount,
    rightQualifiedCount,
    leftQualified: leftQualifiedCount > 0,
    rightQualified: rightQualifiedCount > 0,
    missingLegs,
    qualifyingDirects,
    reason: canEarnPairing
      ? null
      : 'Binary pairing unlocks only after you personally recruit at least one qualified direct on the left leg and one on the right leg. Spillover placements from your upline do not count.',
  };
}

async function collectDirectSponsorRowsViaClosure(ownerUid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT u.uid, u.refid, u.drefid, u.position, u.accttype, u.currentaccttype,
            u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
            c.leg AS owner_leg,
            m.username,
            TRIM(CONCAT(COALESCE(m.firstname, ''), ' ', COALESCE(m.lastname, ''))) AS full_name
       FROM usertab u
       INNER JOIN binary_tree_closuretab c
               ON c.descendant_uid = u.uid
              AND c.ancestor_uid = ?
              AND c.depth > 0
              AND c.leg IN ('left', 'right')
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.drefid = ?
      ORDER BY u.datereg ASC, u.uid ASC`,
    [ownerUid, ownerUid]
  );

  return rows;
}

async function collectDirectSponsorRowsRecursive(ownerUid, conn = pool) {
  const collected = [];

  async function walk(parentUid, ownerLeg = null) {
    const [rows] = await conn.query(
      `SELECT u.uid, u.refid, u.drefid, u.position, u.accttype, u.currentaccttype,
              u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
              m.username,
              TRIM(CONCAT(COALESCE(m.firstname, ''), ' ', COALESCE(m.lastname, ''))) AS full_name
         FROM usertab u
         LEFT JOIN memberstab m ON m.uid = u.uid
        WHERE u.refid = ?
        ORDER BY u.position ASC, u.uid ASC`,
      [parentUid]
    );

    for (const row of rows) {
      const leg = ownerLeg || (Number(row.position || 0) === 1 ? 'left' : 'right');
      const normalized = {
        ...row,
        owner_leg: leg,
      };
      if (Number(row.drefid || 0) === Number(ownerUid || 0)) {
        collected.push(normalized);
      }
      await walk(row.uid, leg);
    }
  }

  await walk(ownerUid, null);
  return collected;
}

async function getBinaryPairingEligibility(ownerUid, conn = pool) {
  let rows = [];
  try {
    rows = await collectDirectSponsorRowsViaClosure(ownerUid, conn);
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    rows = await collectDirectSponsorRowsRecursive(ownerUid, conn);
  }

  const effectiveRows = [];
  for (const row of rows) {
    const effectiveRow = await getEffectiveAccountState(row.uid, row, conn);
    if (!effectiveRow) continue;
    effectiveRows.push({
      ...effectiveRow,
      owner_leg: row.owner_leg,
      username: row.username || null,
      full_name: row.full_name || row.username || `UID ${row.uid}`,
      drefid: row.drefid,
    });
  }

  return summarizeQualifiedDirectLegs(ownerUid, effectiveRows);
}

module.exports = {
  summarizeQualifiedDirectLegs,
  getBinaryPairingEligibility,
};
