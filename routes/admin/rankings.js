/**
 * Admin Rankings Routes (DOC2 §4.2)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAllRankings, processIncentive } = require('../../services/ranking');
const { listRankableEventsForMember } = require('../../services/rankingRace');

/**
 * GET /api/admin/rankings?page=1
 * View all ranked members
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));
    const result = await getAllRankings(page, perPage);
    res.json(result);
  } catch (err) {
    console.error('[Admin Rankings] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/rankings/:uid/process
 * Mark incentive as claimed
 */
router.put('/:uid/process', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const result = await processIncentive(uid, {
      req,
      adminUid: req.session.adminid,
    });
    if (result.success) {
      res.json({
        success: true,
        message: 'Next pending ranking bonus claim released',
        ...result,
      });
    } else {
      res.status(400).json({ error: result.error || 'No pending incentive found' });
    }
  } catch (err) {
    console.error('[Admin Rankings] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/rankings/:uid/events?page=1
 * Per-member rankable-event ledger (the same authoritative basis the rank engine uses),
 * so admins get a live Transaction History view for any member — mirrors /api/ranking/events.
 */
router.get('/:uid/events', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(400).json({ error: 'Invalid member id' });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(5, Number(req.query.perPage) || 25));

    const events = await listRankableEventsForMember(uid);
    const sorted = [...events].sort((a, b) =>
      String(b.sourceEventTs || '').localeCompare(String(a.sourceEventTs || ''))
      || Number(b.sourceEventId || 0) - Number(a.sourceEventId || 0));

    const total = sorted.length;
    const totalPoints = sorted.reduce((sum, e) => sum + Number(e.points || 0), 0);
    const offset = (page - 1) * perPage;
    const pageRows = sorted.slice(offset, offset + perPage);

    const ids = [...new Set(pageRows.map((r) => Number(r.sourceMemberUid)).filter(Boolean))];
    let nameMap = {};
    if (ids.length) {
      const [mrows] = await pool.query(
        `SELECT uid, username,
                TRIM(CONCAT(COALESCE(firstname,''),' ',COALESCE(lastname,''))) AS fullname
           FROM memberstab WHERE uid IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      nameMap = Object.fromEntries(mrows.map((m) => [Number(m.uid), m]));
    }

    res.json({
      events: pageRows.map((r) => {
        const m = nameMap[Number(r.sourceMemberUid)] || null;
        return {
          repurchaseId: Number(r.sourceEventId || 0),
          sourceUid: Number(r.sourceMemberUid || 0),
          sourceUsername: m?.username || null,
          sourceName: (m?.fullname && m.fullname.trim()) || m?.username || `UID ${r.sourceMemberUid}`,
          depth: Number(r.sourceDepth || 0),
          points: Number(r.points || 0),
          eventTs: r.sourceEventTs,
        };
      }),
      total,
      totalPoints,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      basisLabel: 'Remaining rankable repurchase points',
    });
  } catch (err) {
    console.error('[Admin Rankings] Events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
