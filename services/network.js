/**
 * Network / Genealogy Service
 * 1:1 port of PHP network-fnc.php
 *
 * Handles binary tree traversal, genealogy building, and network validation
 */
const { pool } = require('../config/database');
const { getAccountTypeName } = require('../utils/helpers');
const { getEffectiveAccountState, getAccountStateLabel, getAccountEntryAuditInfo, countsForPairingSource } = require('./accountState');
const { getPackageBinaryValue } = require('./packagePolicy');

function resolveGenealogyPoints(currentaccttype, storedBinaryPoints) {
  const numericStored = Number(storedBinaryPoints || 0);
  if (numericStored > 0) return numericStored;
  return getPackageBinaryValue(currentaccttype);
}

/**
 * Get all downline UIDs recursively via refid (binary tree)
 * Mirrors PHP getNetworklist()
 */
async function getNetworkList(parent) {
  const list = [];
  await _traverseNetwork(parent, list);
  return list;
}

async function getNetworkMembersDetailed(rootUid, maxDepth = 10) {
  try {
    const [rows] = await pool.query(
      `SELECT c.descendant_uid AS uid, c.depth, c.leg,
              u.public_uid, u.currentaccttype, u.position, u.binarypoints, u.datereg,
              m.username, m.firstname, m.lastname
       FROM binary_tree_closuretab c
       INNER JOIN usertab u ON u.uid = c.descendant_uid
       LEFT JOIN memberstab m ON m.uid = u.uid
       WHERE c.ancestor_uid = ? AND c.depth > 0 AND c.depth <= ?
       ORDER BY c.depth ASC, u.position ASC, u.id ASC`,
      [rootUid, maxDepth]
    );

    return Promise.all(rows.map(async (row) => {
      const effectiveRow = await getEffectiveAccountState(row.uid, row);
      return {
        uid: Number(row.uid),
        publicUid: row.public_uid || null,
        username: row.username,
        fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
        accttype: Number(row.currentaccttype || 0),
        accttypeName: getAccountTypeName(row.currentaccttype),
        depth: Number(row.depth || 0),
        leg: row.leg || null,
        position: Number(row.position || 0),
        binaryPoints: resolveGenealogyPoints(row.currentaccttype, row.binarypoints),
        datereg: row.datereg,
        accountStateLabel: getAccountStateLabel(effectiveRow || row),
      };
    }));
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;

    const results = [];
    await _traverseNetworkDetailed(rootUid, results, 1, maxDepth, null);
    return results;
  }
}

async function _traverseNetwork(parent, list) {
  const [rows] = await pool.query(
    'SELECT uid, refid, drefid, datereg FROM usertab WHERE refid = ?',
    [parent]
  );

  for (const row of rows) {
    list.push(row.uid);
    await _traverseNetwork(row.uid, list);
  }
}

async function _traverseNetworkDetailed(parent, list, depth, maxDepth, leg) {
  if (depth > maxDepth) return;

  const [rows] = await pool.query(
    `SELECT u.uid, u.public_uid, u.currentaccttype, u.position, u.binarypoints, u.datereg,
            m.username, m.firstname, m.lastname
     FROM usertab u
     LEFT JOIN memberstab m ON m.uid = u.uid
     WHERE u.refid = ?
     ORDER BY u.position ASC, u.id ASC`,
    [parent]
  );

  for (const row of rows) {
    const rowLeg = leg || (Number(row.position) === 1 ? 'left' : 'right');
    list.push({
      uid: Number(row.uid),
      publicUid: row.public_uid || null,
      username: row.username,
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
      accttype: Number(row.currentaccttype || 0),
      accttypeName: getAccountTypeName(row.currentaccttype),
      depth,
      leg: rowLeg,
      position: Number(row.position || 0),
      binaryPoints: resolveGenealogyPoints(row.currentaccttype, row.binarypoints),
      datereg: row.datereg,
      accountStateLabel: getAccountStateLabel(await getEffectiveAccountState(row.uid, row)),
    });
    await _traverseNetworkDetailed(row.uid, list, depth + 1, maxDepth, rowLeg);
  }
}

/**
 * Build genealogy tree structure for display (3 levels deep)
 * Mirrors PHP getGenealogy() from genealogy-tree.php
 */
async function getGenealogyTree(rootUid, maxDepth = 3) {
  return await _buildTreeNode(rootUid, 1, maxDepth);
}

async function _buildTreeNode(uid, depth, maxDepth) {
  // Get member info
  const [rows] = await pool.query(
    `SELECT m.uid, m.firstname, m.lastname, m.middlename, m.username,
            u.uid as uUid, u.refid, u.drefid, u.accttype, u.currentaccttype,
            u.position, u.codeid, u.datereg, u.public_uid, u.binarypoints
     FROM memberstab m, usertab u
     WHERE m.uid = u.uid AND u.uid = ?`,
    [uid]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const node = {
    uid: row.uid,
    publicUid: row.public_uid || null,
    username: row.username,
    firstname: row.firstname,
    lastname: row.lastname,
    fullname: `${row.firstname} ${row.lastname}`,
    accttype: row.currentaccttype,
    accttypeName: getAccountTypeName(row.currentaccttype),
    codeid: row.codeid,
    datereg: row.datereg,
    position: row.position,
    binaryPoints: resolveGenealogyPoints(row.currentaccttype, row.binarypoints),
    accountStateLabel: getAccountStateLabel(await getEffectiveAccountState(uid, row)),
    left: null,
    right: null,
    hasLeftSlot: true,
    hasRightSlot: true,
  };

  if (depth >= maxDepth) {
    // Check if children exist without loading them
    const [children] = await pool.query(
      'SELECT uid, position FROM usertab WHERE refid = ?',
      [uid]
    );
    node.hasLeftSlot = !children.some(c => c.position === 1);
    node.hasRightSlot = !children.some(c => c.position === 2);
    node.childCount = children.length;
    return node;
  }

  // Get left child (position 1)
  const [leftRows] = await pool.query(
    'SELECT uid FROM usertab WHERE refid = ? AND position = 1',
    [uid]
  );

  if (leftRows.length > 0) {
    node.left = await _buildTreeNode(leftRows[0].uid, depth + 1, maxDepth);
    node.hasLeftSlot = false;
  }

  // Get right child (position 2)
  const [rightRows] = await pool.query(
    'SELECT uid FROM usertab WHERE refid = ? AND position = 2',
    [uid]
  );

  if (rightRows.length > 0) {
    node.right = await _buildTreeNode(rightRows[0].uid, depth + 1, maxDepth);
    node.hasRightSlot = false;
  }

  return node;
}

/**
 * Check if a UID is within a user's network
 */
async function isInNetwork(rootUid, targetUid) {
  if (rootUid === targetUid) return true;
  const network = await getNetworkList(rootUid);
  return network.includes(targetUid);
}

/**
 * Get direct referrals for a user
 * Mirrors PHP mydirectreferrals.php query
 */
async function getDirectReferrals(uid) {
  const [rows] = await pool.query(
    `SELECT m.uid, m.firstname, m.lastname, m.middlename, m.username,
            u.uid as uUid, u.codeid, u.mainid, u.drefid, u.currentaccttype,
            u.activationcode, u.datereg
     FROM memberstab m, usertab u
     WHERE m.uid = u.uid AND u.drefid = ?`,
    [uid]
  );

  return Promise.all(rows.map(async (row) => {
    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    const auditInfo = getAccountEntryAuditInfo(effectiveRow || row);

    return {
      uid: row.uid,
      username: row.username,
      fullname: `${row.firstname} ${row.lastname}`,
      accttype: Number(effectiveRow?.currentaccttype || row.currentaccttype || 0),
      accttypeName: getAccountTypeName(effectiveRow?.currentaccttype || row.currentaccttype),
      codeid: Number(effectiveRow?.codeid || row.codeid || 0),
      entryType: auditInfo.entryLabel,
      entryCode: auditInfo.entryCode,
      accountStateLabel: getAccountStateLabel(effectiveRow || row),
      sponsorCreditEligible: Boolean(auditInfo.sponsorCreditEligible),
      sourceBinaryEligible: Boolean(auditInfo.sourceBinaryEligible),
      datereg: row.datereg,
    };
  }));
}

/**
 * Get pairing (left/right) account counts and points
 * Used in dashboard
 */
async function getPairingCounts(uid) {
  const result = {
    totalLeft: 0, totalPointsLeft: 0,
    totalRight: 0, totalPointsRight: 0,
  };

  // Always traverse usertab recursively so that PHP-era registrations (not yet
  // in binary_tree_closuretab) are counted. The closure table is only partially
  // backfilled and using it alone produces silently truncated counts.
  await _collectSubtreePairingCounts(uid, 'left', result);
  await _collectSubtreePairingCounts(uid, 'right', result);
  return result;
}

async function _collectSubtreePairingCounts(parentUid, leg, result) {
  const position = leg === 'left' ? 1 : 2;
  const [rows] = await pool.query(
    `SELECT uid, refid, drefid, position, accttype, currentaccttype, binarypoints,
            codeid, cdamount, cdtotal, cdstatus
       FROM usertab
      WHERE refid = ? AND position = ?`,
    [parentUid, position]
  );

  for (const row of rows) {
    // Count ALL members regardless of eligibility; only add BP for eligible sources.
    if (leg === 'left') {
      result.totalLeft += 1;
    } else {
      result.totalRight += 1;
    }

    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    if (effectiveRow && countsForPairingSource(effectiveRow)) {
      const points = resolveGenealogyPoints(effectiveRow.currentaccttype, effectiveRow.binarypoints);
      if (leg === 'left') {
        result.totalPointsLeft += Number(points || 0);
      } else {
        result.totalPointsRight += Number(points || 0);
      }
    }

    await _collectDescendantPairingCounts(row.uid, leg, result);
  }
}

async function _collectDescendantPairingCounts(uid, rootLeg, result) {
  const [rows] = await pool.query(
    `SELECT uid, refid, drefid, position, accttype, currentaccttype, binarypoints,
            codeid, cdamount, cdtotal, cdstatus
       FROM usertab
      WHERE refid = ?`,
    [uid]
  );

  for (const row of rows) {
    // Count ALL members; only add BP for eligible sources.
    if (rootLeg === 'left') {
      result.totalLeft += 1;
    } else {
      result.totalRight += 1;
    }

    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    if (effectiveRow && countsForPairingSource(effectiveRow)) {
      const points = resolveGenealogyPoints(effectiveRow.currentaccttype, effectiveRow.binarypoints);
      if (rootLeg === 'left') {
        result.totalPointsLeft += Number(points || 0);
      } else {
        result.totalPointsRight += Number(points || 0);
      }
    }

    await _collectDescendantPairingCounts(row.uid, rootLeg, result);
  }
}

module.exports = {
  getNetworkList,
  getNetworkMembersDetailed,
  getGenealogyTree,
  isInNetwork,
  getDirectReferrals,
  getPairingCounts,
  resolveGenealogyPoints,
};
