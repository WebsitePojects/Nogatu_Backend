/**
 * Genealogy / Network Tree Routes
 * 1:1 port of PHP genealogy-tree.php + genealogy.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { getGenealogyTree, isInNetwork, getNetworkList } = require('../services/network');

/**
 * GET /api/genealogy/tree?id=<uid>
 * Get binary tree structure for display
 */
router.get('/tree', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    let targetUid = req.query.id ? Number(req.query.id) : uid;

    // Validate target is in user's network
    if (targetUid !== uid) {
      const inNetwork = await isInNetwork(uid, targetUid);
      if (!inNetwork) targetUid = uid;
    }

    const tree = await getGenealogyTree(targetUid, 4);

    res.json({
      tree,
      rootUid: targetUid,
      sessionUid: uid,
    });
  } catch (err) {
    console.error('[Genealogy] Tree error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/genealogy/network
 * Get full network list (all downline UIDs)
 */
router.get('/network', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const network = await getNetworkList(uid);
    res.json({ network, count: network.length });
  } catch (err) {
    console.error('[Genealogy] Network error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
