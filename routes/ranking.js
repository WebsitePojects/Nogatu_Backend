/**
 * Ranking Routes (DOC2 §4.2)
 * Member ranking progress
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { getRankProgress } = require('../services/ranking');
const { getRankingExplanation } = require('../services/rankingTransparency');
const { listRankableEventsForMember, listAllContributingEventsForMember, toEpoch } = require('../services/rankingRace');

/**
 * GET /api/ranking
 * Get member's rank progress
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const progress = await getRankProgress(req.session.uid);
    res.json(progress);
  } catch (err) {
    console.error('[Ranking] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/explain', memberAuth, async (req, res) => {
  try {
    const explanation = await getRankingExplanation(req.session.uid);
    res.json(explanation);
  } catch (err) {
    console.error('[Ranking] Explain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/ranking/events?page=1&perPage=25
 * Paginated live ledger of the VALID rankable repurchase events that make up the
 * member's remaining rankable points — one row per repurchase event with its
 * remaining (post-consumption) basis points, source member, sponsor depth, date.
 * Read-only; sourced from listRankableEventsForMember (the same authoritative
 * basis the rank engine uses), so the table always reconciles to the summary.
 */
router.get('/events', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(5, Number(req.query.perPage) || 25));
    const scope = req.query.scope === 'full' ? 'full' : 'remaining';

    const events = scope === 'full'
      ? await listAllContributingEventsForMember(uid)
      : await listRankableEventsForMember(uid);
    const sorted = [...events].sort((a, b) =>
      toEpoch(b.sourceEventTs) - toEpoch(a.sourceEventTs)
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
          consumed: Number(r.consumedPoints || 0),
          remaining: Number(r.remainingPoints ?? r.points ?? 0),
          eventTs: r.sourceEventTs,
          processId: r.sourceProcessId || null,
        };
      }),
      total,
      totalPoints,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      scope,
      basisLabel: scope === 'full'
        ? 'All contributing repurchase points (lifetime)'
        : 'Remaining rankable repurchase points',
    });
  } catch (err) {
    console.error('[Ranking] Events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
