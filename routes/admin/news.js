const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../../services/schemaReadiness');
const { cloudinary } = require('../../utils/cloudinary');

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const isImage = file.mimetype?.startsWith('image/');
    const isVideo = file.mimetype?.startsWith('video/');
    if (!isImage && !isVideo) {
      return cb(new Error('Only image or video files are allowed'));
    }
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('media')(req, res, (err) => {
    if (!err) {
      // Enforce per-type size limit after multer passes
      if (req.file) {
        const isImage = req.file.mimetype?.startsWith('image/');
        if (isImage && req.file.size > IMAGE_MAX_BYTES) {
          return res.status(400).json({ error: 'Image exceeds 5 MB file size limit' });
        }
      }
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Video exceeds 100 MB file size limit' });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload' });
    }

    if (String(err.message || '').includes('Only image or video files')) {
      return res.status(400).json({ error: err.message });
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

// Extract Cloudinary public_id from a secure_url
function extractCloudinaryPublicId(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.includes('res.cloudinary.com')) return null;
  // https://res.cloudinary.com/{cloud}/{type}/upload/[transform/]v{ver}/{public_id}.{ext}
  const match = url.match(/\/upload\/(?:[^/]+\/)*(?:v\d+\/)?(.+)\.[^.]+$/);
  return match ? match[1] : null;
}

async function deleteFromCloudinary(mediaUrl) {
  if (!cloudinary || !mediaUrl) return;
  const publicId = extractCloudinaryPublicId(mediaUrl);
  if (!publicId) return;
  const resourceType = mediaUrl.includes('/video/') ? 'video' : 'image';
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    // Log but don't block — DB operation is already done
    console.error('[Cloudinary] Delete error for', publicId, ':', err.message);
  }
}

async function uploadToCloudinary(file) {
  if (!file) return null;
  if (!cloudinary) {
    const error = new Error('Media upload service is not configured');
    error.code = 'UPLOAD_NOT_CONFIGURED';
    throw error;
  }

  const isVideo = file.mimetype?.startsWith('video/');

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'nogatu/news',
        resource_type: isVideo ? 'video' : 'image',
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
router.use(adminAuth, adminRights([1, 3]));
router.use(async (_req, res, next) => {
  try {
    await assertSchemaRequirements(SCHEMA_REQUIREMENTS.NEWS, 'Admin news');
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

// GET /api/admin/news
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

// POST /api/admin/news
router.post('/', handleUpload, async (req, res) => {
  try {
    const { title, content, type = 'news', image_url = null } = req.body;
    const isPublished = toBool(req.body?.is_published, true);
    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!['news', 'announcement', 'promo', 'memo'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (normalizedTitle.length > 255) {
      return res.status(400).json({ error: 'Title is too long (max 255 characters)' });
    }
    if (normalizedContent.length > 8000) {
      return res.status(400).json({ error: 'Content is too long (max 8000 characters)' });
    }

    const uploadedUrl = await uploadToCloudinary(req.file);
    const mediaUrl = uploadedUrl || normalizeImageUrl(image_url);

    const [result] = await pool.query(
      'INSERT INTO newstab (title, content, type, image_url, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [normalizedTitle, normalizedContent, type, mediaUrl, isPublished ? 1 : 0, req.session.adminid]
    );

    res.json({ success: true, id: result.insertId, image_url: mediaUrl });
  } catch (err) {
    console.error('[Admin/News] POST error:', err.message);
    if (err.code === 'UPLOAD_NOT_CONFIGURED' || String(err.message || '').includes('Image URL must start')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// PUT /api/admin/news/:id
router.put('/:id', handleUpload, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid post reference' });
    }

    const { title, content, type, image_url } = req.body;
    const isPublished = toBool(req.body?.is_published, true);
    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!['news', 'announcement', 'promo', 'memo'].includes(type || 'news')) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (normalizedTitle.length > 255) {
      return res.status(400).json({ error: 'Title is too long (max 255 characters)' });
    }
    if (normalizedContent.length > 8000) {
      return res.status(400).json({ error: 'Content is too long (max 8000 characters)' });
    }

    // Fetch existing post to get old media URL for cleanup
    const [[existing]] = await pool.query('SELECT image_url FROM newstab WHERE id = ?', [id]);
    const oldMediaUrl = existing?.image_url || null;

    let mediaUrl;
    if (req.file) {
      // New file uploaded — upload it, then delete old Cloudinary asset
      const uploadedUrl = await uploadToCloudinary(req.file);
      mediaUrl = uploadedUrl;
      if (oldMediaUrl && oldMediaUrl !== mediaUrl) {
        await deleteFromCloudinary(oldMediaUrl);
      }
    } else if (image_url !== undefined) {
      // image_url field explicitly sent — respect it (could be empty to clear media)
      const requestedUrl = normalizeImageUrl(image_url);
      if (!requestedUrl && oldMediaUrl) {
        // Clearing media — delete old Cloudinary asset
        await deleteFromCloudinary(oldMediaUrl);
      }
      mediaUrl = requestedUrl;
    } else {
      // Not changing media — keep existing
      mediaUrl = oldMediaUrl;
    }

    await pool.query(
      'UPDATE newstab SET title = ?, content = ?, type = ?, image_url = ?, is_published = ? WHERE id = ?',
      [normalizedTitle, normalizedContent, type || 'news', mediaUrl, isPublished ? 1 : 0, id]
    );

    res.json({ success: true, image_url: mediaUrl });
  } catch (err) {
    console.error('[Admin/News] PUT error:', err.message);
    if (err.code === 'UPLOAD_NOT_CONFIGURED' || String(err.message || '').includes('Image URL must start')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE /api/admin/news/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid post reference' });
    }

    // Fetch media URL before deleting so we can clean up Cloudinary
    const [[existing]] = await pool.query('SELECT image_url FROM newstab WHERE id = ?', [id]);
    const mediaUrl = existing?.image_url || null;

    await pool.query('DELETE FROM newstab WHERE id = ?', [id]);

    // Delete Cloudinary asset after DB row is gone (non-blocking if it fails)
    if (mediaUrl) {
      deleteFromCloudinary(mediaUrl).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/News] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// PATCH /api/admin/news/:id/toggle
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
