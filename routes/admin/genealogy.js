/**
 * Admin Genealogy Routes
 * Mirrors the member genealogy APIs, without network restriction, for full admin visibility.
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const { pool } = require('../../config/database');
const { getGenealogyTree, getNetworkMembersDetailed, getUnilevelTree, getSubtreeFlat, getUnilevelPointsHistory, getPairingCounts, flatTreeVersion: treeVersion } = require('../../services/network');
const { setRankExclusion, loadExcludedSet, releaseConsumptionForUids } = require('../../services/rankExclusions');
const { refreshRankingForest } = require('../../services/ranking');

function packageColor(accttype) {
  const key = Number(accttype || 0);
  if (key >= 60) return 'diamond';
  if (key >= 50) return 'garnet';
  if (key >= 40) return 'platinum';
  if (key >= 30) return 'gold';
  if (key >= 20) return 'silver';
  return 'bronze';
}

async function resolveRootUid(value, username) {
  if (/^\d+$/.test(String(value || ''))) return Number(value);
  if (value) {
    const [rows] = await pool.query(
      'SELECT uid FROM usertab WHERE public_uid = ? OR referral_slug = ? LIMIT 1',
      [value, value]
    );
    if (rows.length) return Number(rows[0].uid);
  }
  if (username) {
    const [rows] = await pool.query(
      `SELECT u.uid
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       WHERE m.username = ?
       LIMIT 1`,
      [username]
    );
    if (rows.length) return Number(rows[0].uid);
  }
  return 0;
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

  return rows.map((row) => ({
    uid: row.public_uid || String(row.uid),
    internalUid: row.uid,
    displayName: `${row.firstname || ''} ${String(row.lastname || '').slice(0, 1)}.`.trim() || row.username || `Member ${row.uid}`,
    username: row.username,
    packageType: packageColor(row.currentaccttype),
    position: Number(row.position) === 1 ? 'left' : 'right',
    binaryPoints: Number(row.binarypoints || 0),
    leftChildCount: Number(row.leftChildCount || 0),
    rightChildCount: Number(row.rightChildCount || 0),
    hasMoreLeft: Number(row.leftChildCount || 0) > 0,
    hasMoreRight: Number(row.rightChildCount || 0) > 0,
  }));
}

router.get('/tree', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) {
      return res.status(400).json({ error: 'Account ID, public UID, referral slug, or username required' });
    }

    const requestedDepth = Math.min(20, Math.max(1, Number(req.query.depth) || 5));
    const tree = await getGenealogyTree(rootUid, requestedDepth);
    res.json({ tree, rootUid, depth: requestedDepth });
  } catch (error) {
    console.error('[Admin Genealogy] Tree error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/genealogy/unilevel/tree?username=<name>&depth=<n>
 * Unilevel / sponsor tree (drefid) for ANY account — full admin visibility, no
 * network restriction. Used to inspect company/main accounts' sponsor downline
 * (e.g. to decide which accounts to exclude from rank promotion).
 */
router.get('/unilevel/tree', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) {
      return res.status(400).json({ error: 'Account ID, public UID, referral slug, or username required' });
    }

    const requestedDepth = Math.min(20, Math.max(1, Number(req.query.depth) || 5));
    const tree = await getUnilevelTree(rootUid, requestedDepth);
    res.json({ tree, rootUid, depth: requestedDepth });
  } catch (error) {
    console.error('[Admin Genealogy] Unilevel tree error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/genealogy/{unilevel,binary}/flat?username=<name>
 * Entire subtree of ANY account as a flat adjacency list (root → deepest) for the
 * infinite-tree client. Admin loads on search only (no preload).
 */
router.get('/unilevel/flat', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) return res.status(400).json({ error: 'Username, account ID, public UID, or referral slug required' });
    const nodes = await getSubtreeFlat(rootUid, 'unilevel');
    res.json({ rootUid, treeType: 'unilevel', count: nodes.length, version: treeVersion(nodes), nodes });
  } catch (error) {
    console.error('[Admin Genealogy] Unilevel flat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/genealogy/unilevel/points-history?username=<name>&page=&perPage=
 * Per-entry repurchase history (producttype>=100) for the account's sponsor downline
 * — the individual events summing into its "points passed to upline" total, plus the
 * grand total + count. Read-only; backs the admin Unilevel Points Entry History panel.
 */
router.get('/unilevel/points-history', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) return res.status(400).json({ error: 'Username, account ID, public UID, or referral slug required' });
    const data = await getUnilevelPointsHistory(rootUid, { page: req.query.page, perPage: req.query.perPage });
    res.json({ rootUid, ...data });
  } catch (error) {
    console.error('[Admin Genealogy] Unilevel points-history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/binary/flat', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) return res.status(400).json({ error: 'Username, account ID, public UID, or referral slug required' });
    const nodes = await getSubtreeFlat(rootUid, 'binary');
    // The searched account's OWN sponsor (drefid) — subtree nodes can't carry it
    // (the root's parentUid is nulled), so the admin UI needs it here. Read-only.
    const [[sponsorRow]] = await pool.query(
      `SELECT m.uid, m.username,
              TRIM(CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,''))) AS fullname
         FROM usertab u
         JOIN memberstab m ON m.uid = u.drefid
        WHERE u.uid = ? LIMIT 1`,
      [rootUid]
    );
    const rootSponsor = sponsorRow
      ? { uid: Number(sponsorRow.uid), username: sponsorRow.username, fullname: (sponsorRow.fullname || '').trim() || null }
      : null;
    // The root's BINARY parent (refid) — lets the admin UI navigate upward, tree
    // by tree, until the top of the whole structure. Read-only.
    const [[uplineRow]] = await pool.query(
      `SELECT m.uid, m.username,
              TRIM(CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,''))) AS fullname
         FROM usertab u
         JOIN memberstab m ON m.uid = u.refid
        WHERE u.uid = ? LIMIT 1`,
      [rootUid]
    );
    const rootUpline = uplineRow
      ? { uid: Number(uplineRow.uid), username: uplineRow.username, fullname: (uplineRow.fullname || '').trim() || null }
      : null;
    // Both uids are folded into the version so warm client caches (which predate
    // these fields, or a re-placement/re-sponsorship) swap in the fresh payload.
    res.json({
      rootUid,
      treeType: 'binary',
      count: nodes.length,
      version: `${treeVersion(nodes)}-s${rootSponsor ? rootSponsor.uid : 0}-p${rootUpline ? rootUpline.uid : 0}`,
      nodes,
      rootSponsor,
      rootUpline,
    });
  } catch (error) {
    console.error('[Admin Genealogy] Binary flat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/genealogy/pairing-reconcile?id=|username=
 * Admin verify: total Left/Right binary points (PV + peso), matched PV = min(L,R),
 * and the authoritative lifetime SMB (payouttotaltab.ttlincome2) side by side, so an
 * admin can reconcile leg totals against paid pairing income. Read-only.
 * MONEY NOTE: matched PV is a CURRENT snapshot; lifetime SMB is cumulative already-paid
 * — different quantities, NOT expected to be equal. Shown transparently, never forced.
 */
router.get('/pairing-reconcile', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) return res.status(400).json({ error: 'Username, account ID, public UID, or referral slug required' });
    const BP_PESO = 250;
    const counts = await getPairingCounts(rootUid);
    const leftPeso = Number(counts.totalPointsLeft || 0);
    const rightPeso = Number(counts.totalPointsRight || 0);
    const leftPV = Math.round(leftPeso / BP_PESO);
    const rightPV = Math.round(rightPeso / BP_PESO);
    const matchedPV = Math.min(leftPV, rightPV);
    const [[totRow]] = await pool.query(
      'SELECT COALESCE(ttlincome2,0) AS smb FROM payouttotaltab WHERE uid = ? LIMIT 1', [rootUid]
    );
    const [[mRow]] = await pool.query(
      `SELECT username, TRIM(CONCAT(COALESCE(firstname,''),' ',COALESCE(lastname,''))) AS fullname
         FROM memberstab WHERE uid = ? LIMIT 1`, [rootUid]
    );
    res.json({
      rootUid,
      username: mRow?.username || null,
      fullname: (mRow?.fullname && mRow.fullname.trim()) || mRow?.username || `UID ${rootUid}`,
      leftAccounts: Number(counts.totalLeft || 0),
      rightAccounts: Number(counts.totalRight || 0),
      leftPV,
      rightPV,
      matchedPV,
      leftPeso,
      rightPeso,
      matchedPeso: matchedPV * BP_PESO,
      lifetimeSmb: Number(totRow?.smb || 0),
      note: 'Left/Right PV = live full-subtree binary points (÷250). Matched PV = min(L,R) is a current snapshot. Lifetime SMB = authoritative cumulative pairing already paid (ttlincome2) — a different quantity from the snapshot; do not expect it to equal matched PV.',
    });
  } catch (error) {
    console.error('[Admin Genealogy] Pairing reconcile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Rank exclusions — flag/unflag a (company/system) account so it can never rank up
 * and consume the network's repurchase points. Managed from the Unilevel viewer.
 */
router.get('/rank-exclusions', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const set = await loadExcludedSet();
    res.json({ excludedUids: Array.from(set) });
  } catch (error) {
    console.error('[Admin Genealogy] rank-exclusions list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/rank-exclusion', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.body?.uid);
    const excluded = Boolean(req.body?.excluded);
    const reason = String(req.body?.reason || '').slice(0, 255) || null;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    await setRankExclusion(uid, excluded, Number(req.session.adminid) || null, reason);

    let released = null;
    if (excluded) {
      // Atomically give the network back whatever points this account already
      // consumed (delete its consumption + achievements), then recompute the
      // forest in the background so the freed points re-settle the race without
      // blocking the click.
      released = await releaseConsumptionForUids([uid]);
      setImmediate(() => {
        refreshRankingForest().catch((e) => console.error('[rank-exclusion] forest rebuild failed:', e));
      });
    }

    res.json({
      uid,
      excluded,
      released,
      note: excluded
        ? `Flagged + released its consumed points back to the network (${released.global} consumption row(s), ${released.achievements} rank(s) reversed). Rankings are recomputing now.`
        : 'Unflagged. This account is eligible to rank again.',
    });
  } catch (error) {
    console.error('[Admin Genealogy] rank-exclusion set error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/network', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const rootUid = await resolveRootUid(req.query.root || req.query.id, req.query.username);
    if (!rootUid) {
      return res.status(400).json({ error: 'Account ID, public UID, referral slug, or username required' });
    }

    const requestedDepth = Math.min(20, Math.max(1, Number(req.query.depth) || 12));
    const network = await getNetworkMembersDetailed(rootUid, requestedDepth);
    res.json({
      rootUid,
      depth: requestedDepth,
      network,
      count: network.length,
    });
  } catch (error) {
    console.error('[Admin Genealogy] Network error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/expand/:publicUid', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const targetUid = await resolveRootUid(req.params.publicUid, null);
    if (!targetUid) {
      return res.status(404).json({ error: 'Node not found.' });
    }

    const [rootRows] = await pool.query(
      `SELECT u.uid, u.public_uid, u.currentaccttype, m.username, m.firstname, m.lastname
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
       WHERE u.uid = ?
       LIMIT 1`,
      [targetUid]
    );
    if (!rootRows.length) {
      return res.status(404).json({ error: 'Node not found.' });
    }

    const root = rootRows[0];
    const children = await getChildNodes(targetUid);
    const rootNode = {
      uid: root.public_uid || String(root.uid),
      internalUid: root.uid,
      displayName: `${root.firstname || ''} ${String(root.lastname || '').slice(0, 1)}.`.trim() || root.username || `Member ${root.uid}`,
      username: root.username,
      packageType: packageColor(root.currentaccttype),
      position: 'self',
    };

    res.json({
      focusUid: rootNode.uid,
      nodes: [rootNode, ...children],
      edges: children.map((child) => ({
        source: rootNode.uid,
        target: child.uid,
        side: child.position,
      })),
      maxNodesPerPage: 100,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Admin Genealogy] Expand error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
