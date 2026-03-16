/**
 * Admin Genealogy Routes
 * 1:1 port of PHP adminpanel/account-genealogy.php
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getGenealogyTree } = require('../../services/network');
const { getAccountId } = require('../../services/registration');

/**
 * GET /api/admin/genealogy?id=<uid>&username=<username>
 * Get genealogy tree for any member (admin access)
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    let targetUid = Number(req.query.id) || 0;

    // If username provided, resolve to UID
    if (req.query.username && !targetUid) {
      targetUid = await getAccountId(req.query.username);
    }

    if (!targetUid) {
      return res.status(400).json({ error: 'Account ID or username required' });
    }

    const tree = await getGenealogyTree(targetUid, 4);

    res.json({ tree, rootUid: targetUid });
  } catch (err) {
    console.error('[Admin Genealogy] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
