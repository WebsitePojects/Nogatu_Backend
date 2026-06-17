/**
 * Network / Genealogy Service
 * 1:1 port of PHP network-fnc.php
 *
 * Handles binary tree traversal, genealogy building, and network validation
 */
const { pool } = require('../config/database');
const { getAccountTypeName, currentMonthRange } = require('../utils/helpers');
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

/**
 * Build the unilevel / sponsor tree (drefid) for display.
 * Level 0 = the root member (you); each member's direct referrals are the next
 * level down, n-ary (unlimited children per node), up to `maxLevel` levels.
 *
 * A node budget caps total rendered nodes so a leader with a very wide downline
 * cannot generate a runaway payload. Truncated branches keep their childCount
 * and are flagged with `truncated` so the UI can show "more below".
 */
async function getUnilevelTree(rootUid, maxLevel = 3, maxNodes = 600) {
  const budget = { count: 0, max: Math.max(1, Number(maxNodes) || 600) };
  const tree = await _buildUnilevelNode(rootUid, 0, maxLevel, budget);
  await attachUnilevelMaintenancePoints(tree);
  return tree;
}

/**
 * Attach each node's CURRENT-MONTH product maintenance/repurchase points
 * (producttype >= 100) in a single batched query, so the unilevel tree can show
 * a relevant metric instead of binary PV. Defaults every node to 0.
 */
async function attachUnilevelMaintenancePoints(rootNode) {
  if (!rootNode) return;
  const nodes = [];
  (function collect(node) {
    if (!node) return;
    nodes.push(node);
    for (const child of (node.children || [])) collect(child);
  })(rootNode);

  for (const node of nodes) node.maintenancePoints = 0;

  const uids = Array.from(new Set(nodes.map((n) => Number(n.uid)).filter(Boolean)));
  if (uids.length === 0) return;

  const { start, end } = currentMonthRange();
  const placeholders = uids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT uid, COALESCE(SUM(incentivepoints1), 0) AS pts
       FROM repurchasetab
      WHERE uid IN (${placeholders})
        AND producttype >= 100
        AND DATE_FORMAT(transdate, '%Y-%m-%d') >= ?
        AND DATE_FORMAT(transdate, '%Y-%m-%d') <= ?
      GROUP BY uid`,
    [...uids, start, end]
  );
  const ptsByUid = new Map(rows.map((r) => [Number(r.uid), Number(r.pts || 0)]));
  for (const node of nodes) {
    node.maintenancePoints = ptsByUid.get(Number(node.uid)) || 0;
  }
}

async function _buildUnilevelNode(uid, level, maxLevel, budget) {
  const [rows] = await pool.query(
    `SELECT m.uid, m.firstname, m.lastname, m.username,
            u.uid as uUid, u.refid, u.drefid, u.currentaccttype,
            u.codeid, u.datereg, u.public_uid, u.binarypoints
     FROM memberstab m, usertab u
     WHERE m.uid = u.uid AND u.uid = ?`,
    [uid]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  budget.count += 1;

  const node = {
    uid: row.uid,
    publicUid: row.public_uid || null,
    username: row.username,
    firstname: row.firstname,
    lastname: row.lastname,
    fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
    accttype: row.currentaccttype,
    accttypeName: getAccountTypeName(row.currentaccttype),
    codeid: row.codeid,
    datereg: row.datereg,
    level,
    binaryPoints: resolveGenealogyPoints(row.currentaccttype, row.binarypoints),
    accountStateLabel: getAccountStateLabel(await getEffectiveAccountState(uid, row)),
    children: [],
    childCount: 0,
    truncated: false,
  };

  // Direct referrals via the sponsor tree (drefid).
  const [kids] = await pool.query(
    'SELECT uid FROM usertab WHERE drefid = ? ORDER BY id ASC',
    [uid]
  );
  node.childCount = kids.length;
  node.hasMore = kids.length > 0;

  if (level >= maxLevel || kids.length === 0) {
    return node;
  }

  for (const kid of kids) {
    if (budget.count >= budget.max) {
      node.truncated = true;
      break;
    }
    const child = await _buildUnilevelNode(kid.uid, level + 1, maxLevel, budget);
    if (child) node.children.push(child);
  }

  return node;
}

/**
 * Check whether targetUid is the requesting member or sits within their
 * sponsor-tree (unilevel) downline, by walking drefid ancestors upward.
 */
async function isInSponsorNetwork(rootUid, targetUid) {
  const root = Number(rootUid);
  let current = Number(targetUid);
  if (root === current) return true;

  for (let guard = 0; guard < 60 && current > 0; guard += 1) {
    const [rows] = await pool.query(
      'SELECT drefid FROM usertab WHERE uid = ? LIMIT 1',
      [current]
    );
    const parent = Number(rows[0]?.drefid || 0);
    if (!parent) return false;
    if (parent === root) return true;
    current = parent;
  }
  return false;
}

/**
 * Lightweight account-state label from codeid/cdstatus WITHOUT a per-node async
 * lookup — fast enough to apply to every node of a 100k-row flat tree. (The full
 * effective post-upgrade state is heavier and only needed on single-account views.)
 */
function lightAccountStateLabel(codeid, cdstatus) {
  const c = Number(codeid);
  if (c === 2) return 'FS';
  if (c === 3) return Number(cdstatus) === 2 ? 'CD - Paid' : 'CD';
  return 'PD';
}

/**
 * Flat adjacency list of the ENTIRE subtree under rootUid (root → deepest), built
 * with ONE recursive CTE (no per-node queries) so it scales to 100k+ rows. The
 * client rebuilds + virtualizes the tree from this. Phase A of the infinite-tree
 * plan (documentations/ULTRACODE_TREE_AND_TALLY_PLAN.md).
 *
 *   treeType       'unilevel' (drefid, n-ary) | 'binary' (refid + position)
 *   ownPoints      node's current-period maintenance/repurchase points (producttype>=100)
 *   pointsToUpline what this node feeds upward — unilevel: ownPoints; binary: binary points
 */
async function getSubtreeFlat(rootUid, treeType = 'unilevel', maxDepth = 100) {
  const root = Number(rootUid);
  if (!root) return [];
  const isBinary = treeType === 'binary';
  const edge = isBinary ? 'u.refid' : 'u.drefid';
  const depthCap = Math.min(120, Math.max(1, Number(maxDepth) || 100));

  const [rows] = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT u.uid, u.refid, u.drefid, u.position, u.currentaccttype, u.codeid,
              u.cdstatus, u.binarypoints, u.public_uid, 0 AS depth
       FROM usertab u WHERE u.uid = ?
       UNION ALL
       SELECT u.uid, u.refid, u.drefid, u.position, u.currentaccttype, u.codeid,
              u.cdstatus, u.binarypoints, u.public_uid, s.depth + 1
       FROM usertab u
       JOIN subtree s ON ${edge} = s.uid AND u.uid <> s.uid
       WHERE s.depth < ?
     )
     SELECT s.uid, s.refid, s.drefid, s.position, s.currentaccttype, s.codeid,
            s.cdstatus, s.binarypoints, s.public_uid, s.depth,
            m.username, m.firstname, m.lastname
     FROM subtree s
     JOIN memberstab m ON m.uid = s.uid
     ORDER BY s.depth ASC, s.uid ASC`,
    [root, depthCap]
  );
  if (rows.length === 0) return [];

  // Current-month maintenance points — scoped to THIS subtree's uids only (not the
  // whole repurchasetab) and with a SARGable date range so idx(uid,transdate) is
  // usable. Chunked IN keeps the placeholder/packet size bounded on huge trees.
  const { start, end } = currentMonthRange();
  const ptsByUid = new Map();
  const allUids = rows.map((r) => Number(r.uid));
  const CHUNK = 5000;
  for (let i = 0; i < allUids.length; i += CHUNK) {
    const slice = allUids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    // eslint-disable-next-line no-await-in-loop
    const [mp] = await pool.query(
      `SELECT uid, COALESCE(SUM(incentivepoints1),0) AS pts
         FROM repurchasetab
        WHERE uid IN (${ph})
          AND producttype >= 100
          AND transdate >= ? AND transdate < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY uid`,
      [...slice, start, end]
    );
    for (const r of mp) ptsByUid.set(Number(r.uid), Number(r.pts || 0));
  }

  return rows.map((r) => {
    const ownPoints = ptsByUid.get(Number(r.uid)) || 0;
    const parentUid = isBinary ? Number(r.refid) : Number(r.drefid);
    const codeid = Number(r.codeid);
    const cdstatus = Number(r.cdstatus);
    // Binary source eligibility: only PD and fully-paid CD feed binary points upward;
    // FS / unpaid-CD are invisible source nodes (confirmed business rule). Showing
    // their package value as "pts to upline" would mis-attribute point sources.
    // NOTE: raw codeid/cdstatus here; effective post-upgrade state (upgradetab) is a
    // documented follow-up (ULTRACODE plan H1).
    const binaryContributes = codeid === 1 || (codeid === 3 && cdstatus === 2);
    return {
      uid: Number(r.uid),
      publicUid: r.public_uid || null,
      parentUid: Number(r.uid) === root ? null : parentUid,
      position: isBinary ? (Number(r.position) === 1 ? 'left' : Number(r.position) === 2 ? 'right' : null) : null,
      depth: Number(r.depth),
      username: r.username,
      firstname: r.firstname || '',
      lastname: r.lastname || '',
      fullname: `${r.firstname || ''} ${r.lastname || ''}`.trim(),
      accttype: Number(r.currentaccttype),
      accttypeName: getAccountTypeName(r.currentaccttype),
      accountStateLabel: lightAccountStateLabel(codeid, cdstatus),
      ownPoints,
      pointsToUpline: isBinary
        ? (binaryContributes ? resolveGenealogyPoints(r.currentaccttype, r.binarypoints) : 0)
        : ownPoints,
    };
  });
}

/**
 * Structural content hash for a flat tree payload — used by the client's
 * stale-while-revalidate cache to decide whether to swap. Folds each node's
 * identity, parent, position, package, state and points-to-upline into an FNV-1a
 * rolling hash, so a re-placement / upgrade / attribution change invalidates the
 * cache even when the node count and summed maintenance points are unchanged.
 */
function flatTreeVersion(nodes) {
  let h = 0x811c9dc5;
  for (const n of nodes) {
    const s = `${n.uid}:${n.parentUid}:${n.position || ''}:${n.accttype}:${n.accountStateLabel}:${n.pointsToUpline}`;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return `${nodes.length}-${(h >>> 0).toString(36)}`;
}

module.exports = {
  getNetworkList,
  getNetworkMembersDetailed,
  getGenealogyTree,
  getUnilevelTree,
  getSubtreeFlat,
  flatTreeVersion,
  isInNetwork,
  isInSponsorNetwork,
  getDirectReferrals,
  getPairingCounts,
  resolveGenealogyPoints,
};
