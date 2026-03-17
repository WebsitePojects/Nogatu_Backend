const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth } = require('../../middleware/auth');

// All admin news routes require admin authentication
router.use(adminAuth);

// GET /api/admin/news - List all news (including unpublished)
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM newstab ORDER BY created_at DESC'
    );
    res.json({ posts: rows });
  } catch (err) {
    console.error('[Admin/News] GET error:', err.message);
    res.status(500).json({ error: 'Failed to load news' });
  }
});

// POST /api/admin/news - Create new post
router.post('/', async (req, res) => {
  try {
    const { title, content, type = 'news', image_url = null, is_published = 1 } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!['news', 'announcement', 'promo'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const [result] = await pool.query(
      'INSERT INTO newstab (title, content, type, image_url, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [title.trim(), content.trim(), type, image_url || null, is_published ? 1 : 0, req.session.adminid]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('[Admin/News] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// PUT /api/admin/news/:id - Update post
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, type, image_url, is_published } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    await pool.query(
      'UPDATE newstab SET title = ?, content = ?, type = ?, image_url = ?, is_published = ? WHERE id = ?',
      [title.trim(), content.trim(), type || 'news', image_url || null, is_published ? 1 : 0, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE /api/admin/news/:id - Delete post
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM newstab WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// PATCH /api/admin/news/:id/toggle - Toggle publish status
router.patch('/:id/toggle', async (req, res) => {
  try {
    await pool.query(
      'UPDATE newstab SET is_published = NOT is_published WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] TOGGLE error:', err.message);
    res.status(500).json({ error: 'Failed to toggle status' });
  }
});

module.exports = router;
