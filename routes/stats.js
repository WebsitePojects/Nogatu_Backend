const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
let statsCache = {
  expiresAt: 0,
  payload: null,
};

function buildFallbackPayload() {
  return {
    activeMembers: 0,
    networksBuilt: 0,
    cachedAt: new Date().toISOString(),
    source: 'fallback',
  };
}

// GET /api/stats - Public: Get aggregate stats for landing page
router.get('/', async (req, res) => {
  try {
    if (statsCache.payload && statsCache.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      return res.json(statsCache.payload);
    }

    const [[statsRow]] = await pool.query(
      `SELECT
          COUNT(CASE WHEN codeid IS NOT NULL AND codeid != '' THEN 1 END) AS activeMembers,
          COUNT(DISTINCT CASE WHEN mainid IS NOT NULL AND mainid != '' THEN mainid END) AS networksBuilt
       FROM usertab`
    );

    const payload = {
      activeMembers: Number(statsRow?.activeMembers || 0),
      networksBuilt: Number(statsRow?.networksBuilt || 0),
      cachedAt: new Date().toISOString(),
      source: 'database',
    };

    statsCache = {
      payload,
      expiresAt: Date.now() + STATS_CACHE_TTL_MS,
    };

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(payload);
  } catch (err) {
    console.error('[Stats] GET error:', err.message);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(statsCache.payload || buildFallbackPayload());
  }
});

module.exports = router;
