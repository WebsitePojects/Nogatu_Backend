/**
 * Network / Genealogy Service
 * 1:1 port of PHP network-fnc.php
 *
 * Handles binary tree traversal, genealogy building, and network validation
 */
const { pool } = require('../config/database');
const { getAccountTypeName, PACKAGE_BINARY_POINTS } = require('../utils/helpers');

function resolveGenealogyPoints(currentaccttype, storedBinaryPoints) {
  const numericStored = Number(storedBinaryPoints || 0);
  if (numericStored > 0) return numericStored;
  return Number(PACKAGE_BINARY_POINTS[Number(currentaccttype || 0)] || 0);
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

    return rows.map((row) => ({
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

  return rows.map(row => ({
    uid: row.uid,
    username: row.username,
    fullname: `${row.firstname} ${row.lastname}`,
    accttype: row.currentaccttype,
    accttypeName: getAccountTypeName(row.currentaccttype),
    codeid: row.codeid,
    entryType: row.codeid === 1 ? 'Paid Account' : row.codeid === 2 ? 'Free Slot' : 'CD Slot',
    datereg: row.datereg,
  }));
}

/**
 * Get pairing (left/right) account counts and points
 * Used in dashboard
 */
async function getPairingCounts(uid) {
  const [rows] = await pool.query(
    `SELECT position, COUNT(*) as total, SUM(binarypoints) as totalpoints
     FROM usertab WHERE refid = ? GROUP BY position`,
    [uid]
  );

  const result = {
    totalLeft: 0, totalPointsLeft: 0,
    totalRight: 0, totalPointsRight: 0,
  };

  for (const row of rows) {
    if (Number(row.position) === 1) {
      result.totalLeft = Number(row.total);
      result.totalPointsLeft = Number(row.totalpoints || 0);
    } else if (Number(row.position) === 2) {
      result.totalRight = Number(row.total);
      result.totalPointsRight = Number(row.totalpoints || 0);
    }
  }

  return result;
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
