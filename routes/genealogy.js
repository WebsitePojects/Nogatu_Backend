/**
 * Genealogy / Network Tree Routes
 * 1:1 port of PHP genealogy-tree.php + genealogy.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const { getGenealogyTree, isInNetwork, getNetworkList, getNetworkMembersDetailed, resolveGenealogyPoints } = require('../services/network');
const { getEffectiveAccountState, getAccountStateLabel } = require('../services/accountState');

function packageColor(accttype) {
  const key = Number(accttype || 0);
  if (key >= 60) return 'diamond';
  if (key >= 50) return 'garnet';
  if (key >= 40) return 'platinum';
  if (key >= 30) return 'gold';
  if (key >= 20) return 'silver';
  return 'bronze';
}

async function resolvePublicOrInternalUid(value, fallbackUid) {
  if (!value) return Number(fallbackUid);
  if (/^\d+$/.test(String(value))) return Number(value);
  const [rows] = await pool.query('SELECT uid FROM usertab WHERE public_uid = ? OR referral_slug = ? LIMIT 1', [value, value]);
  return Number(rows[0]?.uid || fallbackUid);
}

async function getChildNodes(parentUid) {
  const [rows] = await pool.query(
    `SELECT u.uid, u.public_uid, u.position, u.currentaccttype, u.binarypoints,
            m.username, m.firstname, m.lastname,
            (SELECT COUNT(*) FROM usertab c WHERE c.refid = u.uid AND c.position = 1) AS leftChildCount,
            (SELECT COUNT(*) FROM usertab c WHERE c.refid = u.uid AND c.position = 2) AS rightChildCount
     FROM usertab u
     LEFT JOIN memberstab m ON m.uid = u.uid
     WHERE u.refid = ?
     ORDER BY u.position ASC, u.id ASC`,
    [parentUid]
  );
  return Promise.all(rows.map(async (row) => {
    const effectiveRow = await getEffectiveAccountState(row.uid, row);
    return {
      uid: row.public_uid || String(row.uid),
      internalUid: row.uid,
      displayName: `${row.firstname || ''} ${String(row.lastname || '').slice(0, 1)}.`.trim() || row.username || `Member ${row.uid}`,
      username: row.username,
      packageType: packageColor(row.currentaccttype),
      position: Number(row.position) === 1 ? 'left' : 'right',
      binaryPoints: resolveGenealogyPoints(row.currentaccttype, row.binarypoints),
      accountStateLabel: getAccountStateLabel(effectiveRow || row),
      leftChildCount: Number(row.leftChildCount || 0),
      rightChildCount: Number(row.rightChildCount || 0),
      hasMoreLeft: Number(row.leftChildCount || 0) > 0,
      hasMoreRight: Number(row.rightChildCount || 0) > 0,
    };
  }));
}

/**
 * GET /api/genealogy/tree?id=<uid>
 * Get binary tree structure for display
 */
router.get('/tree', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    let targetUid = await resolvePublicOrInternalUid(req.query.root || req.query.id, uid);
    const requestedDepth = Math.min(12, Math.max(1, Number(req.query.depth) || 4));

    // Validate target is in user's network
    if (targetUid !== uid) {
      const inNetwork = await isInNetwork(uid, targetUid);
      if (!inNetwork) targetUid = uid;
    }

    const tree = await getGenealogyTree(targetUid, requestedDepth);

    res.json({
      tree,
      rootUid: targetUid,
      sessionUid: uid,
      depth: requestedDepth,
    });
  } catch (err) {
    console.error('[Genealogy] Tree error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/expand/:publicUid', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    let targetUid = await resolvePublicOrInternalUid(req.params.publicUid, uid);

    if (targetUid !== uid) {
      const inNetwork = await isInNetwork(uid, targetUid);
      if (!inNetwork) return res.status(403).json({ error: 'Access denied' });
    }

    const [rootRows] = await pool.query(
      `SELECT u.uid, u.public_uid, u.currentaccttype, m.username, m.firstname, m.lastname
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
       WHERE u.uid = ?
       LIMIT 1`,
      [targetUid]
    );
    if (rootRows.length === 0) return res.status(404).json({ error: 'Node not found.' });

    const root = rootRows[0];
    const children = await getChildNodes(targetUid);
    const rootNode = {
      uid: root.public_uid || String(root.uid),
      internalUid: root.uid,
      displayName: `${root.firstname || ''} ${String(root.lastname || '').slice(0, 1)}.`.trim() || root.username || `Member ${root.uid}`,
      username: root.username,
      packageType: packageColor(root.currentaccttype),
      position: 'self',
      accountStateLabel: getAccountStateLabel(await getEffectiveAccountState(root.uid, root)),
    };

    res.json({
      focusUid: rootNode.uid,
      nodes: [rootNode, ...children],
      edges: children.map((child) => ({
        source: rootNode.uid,
        target: child.uid,
        side: child.position,
      })),
      maxNodesPerPage: 50,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Genealogy] Expand error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/genealogy/network
 * Get full network list (all downline UIDs)
 */
router.get('/network', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    let targetUid = await resolvePublicOrInternalUid(req.query.root || req.query.id, uid);
    const requestedDepth = Math.min(12, Math.max(1, Number(req.query.depth) || 10));

    if (targetUid !== uid) {
      const inNetwork = await isInNetwork(uid, targetUid);
      if (!inNetwork) targetUid = uid;
    }

    const members = await getNetworkMembersDetailed(targetUid, requestedDepth);
    res.json({
      rootUid: targetUid,
      depth: requestedDepth,
      network: members,
      count: members.length,
    });
  } catch (err) {
    console.error('[Genealogy] Network error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
