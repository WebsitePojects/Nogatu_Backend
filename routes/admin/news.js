const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../../config/database');
const { adminAuth } = require('../../middleware/auth');
const { cloudinary } = require('../../utils/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image exceeds 5MB file size limit' });
      }
      return res.status(400).json({ error: err.message || 'Invalid image upload' });
    }

    if (String(err.message || '').includes('Only image files are allowed')) {
      return res.status(400).json({ error: 'Only image files are allowed' });
    }

    return res.status(400).json({ error: 'Invalid upload payload' });
  });
}

function normalizeImageUrl(imageUrl) {
  const trimmed = String(imageUrl || '').trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Image URL must start with http:// or https://');
  }
  return trimmed;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function uploadToCloudinary(file) {
  if (!file) return null;
  if (!cloudinary) {
    const error = new Error('Image upload service is not configured');
    error.code = 'UPLOAD_NOT_CONFIGURED';
    throw error;
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'nogatu/news',
        resource_type: 'image',
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result?.secure_url || null);
      }
    );

    uploadStream.end(file.buffer);
  });
}

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
router.post('/', handleUpload, async (req, res) => {
  try {
    const { title, content, type = 'news', image_url = null } = req.body;
    const isPublished = toBool(req.body?.is_published, true);
    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!['news', 'announcement', 'promo'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (normalizedTitle.length > 255) {
      return res.status(400).json({ error: 'Title is too long (max 255 characters)' });
    }
    if (normalizedContent.length > 8000) {
      return res.status(400).json({ error: 'Content is too long (max 8000 characters)' });
    }

    const uploadedUrl = await uploadToCloudinary(req.file);
    const imageUrl = uploadedUrl || normalizeImageUrl(image_url);

    const [result] = await pool.query(
      'INSERT INTO newstab (title, content, type, image_url, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [normalizedTitle, normalizedContent, type, imageUrl, isPublished ? 1 : 0, req.session.adminid]
    );

    res.json({ success: true, id: result.insertId, image_url: imageUrl });
  } catch (err) {
    console.error('[Admin/News] POST error:', err.message);
    if (err.code === 'UPLOAD_NOT_CONFIGURED' || String(err.message || '').includes('Image URL must start')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// PUT /api/admin/news/:id - Update post
router.put('/:id', handleUpload, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, content, type, image_url } = req.body;
        if (!Number.isFinite(id) || id <= 0) {
          return res.status(400).json({ error: 'Invalid post reference' });
        }

    const isPublished = toBool(req.body?.is_published, true);
    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!['news', 'announcement', 'promo'].includes(type || 'news')) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (normalizedTitle.length > 255) {
      return res.status(400).json({ error: 'Title is too long (max 255 characters)' });
    }
    if (normalizedContent.length > 8000) {
      return res.status(400).json({ error: 'Content is too long (max 8000 characters)' });
    }

    const uploadedUrl = await uploadToCloudinary(req.file);
    const imageUrl = uploadedUrl || normalizeImageUrl(image_url);

    await pool.query(
      'UPDATE newstab SET title = ?, content = ?, type = ?, image_url = ?, is_published = ? WHERE id = ?',
      [normalizedTitle, normalizedContent, type || 'news', imageUrl, isPublished ? 1 : 0, id]
    );

    res.json({ success: true, image_url: imageUrl });
  } catch (err) {
    console.error('[Admin/News] PUT error:', err.message);
    if (err.code === 'UPLOAD_NOT_CONFIGURED' || String(err.message || '').includes('Image URL must start')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE /api/admin/news/:id - Delete post
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid post reference' });
    }

    await pool.query('DELETE FROM newstab WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// PATCH /api/admin/news/:id/toggle - Toggle publish status
router.patch('/:id/toggle', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid post reference' });
    }

    await pool.query(
      'UPDATE newstab SET is_published = NOT is_published WHERE id = ?',
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] TOGGLE error:', err.message);
    res.status(500).json({ error: 'Failed to toggle status' });
  }
});

module.exports = router;
