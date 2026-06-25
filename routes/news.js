const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.NEWS, 'News');
  tableReady = true;
}

router.use(async (_req, res, next) => {
  try {
    await ensureTable();
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

// GET /api/news - Public: Get published posts by type
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { type, limit = 50, offset = 0 } = req.query;

    let sql = 'SELECT id, title, content, type, image_url, media_filename, created_at FROM newstab WHERE is_published = 1';
    const params = [];

    if (type && ['news', 'announcement', 'promo', 'memo'].includes(type)) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const [rows] = await pool.query(sql, params);
    res.json({ posts: rows });
  } catch (err) {
    console.error('[News] GET error:', err.message);
    res.status(500).json({ error: 'Failed to load news' });
  }
});

module.exports = router;
