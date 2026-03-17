const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Auto-create news table if it doesn't exist
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS newstab (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  type ENUM('news', 'announcement', 'promo') DEFAULT 'news',
  image_url VARCHAR(500) DEFAULT NULL,
  is_published TINYINT(1) DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_published (is_published),
  INDEX idx_type (type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  try {
    await pool.query(INIT_SQL);
    tableReady = true;
  } catch (err) {
    console.error('[News] Failed to create table:', err.message);
  }
}

// GET /api/news - Public: Get published news/announcements/promos
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { type, limit = 50, offset = 0 } = req.query;

    let sql = 'SELECT id, title, content, type, image_url, created_at FROM newstab WHERE is_published = 1';
    const params = [];

    if (type && ['news', 'announcement', 'promo'].includes(type)) {
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
