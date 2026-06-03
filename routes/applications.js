const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const router = express.Router();
const { pool } = require('../config/database');
const { cloudinary } = require('../utils/cloudinary');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LETTER_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_LETTER_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many application submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LETTER_FILE_SIZE },
});

function normalizeApplicationFields(body = {}) {
  return {
    name: String(body?.name || '').trim(),
    phone: String(body?.phone || '').trim(),
    email: String(body?.email || '').trim().toLowerCase(),
  };
}

function validateLetterOfIntentFile(file) {
  if (!file) {
    return { ok: false, error: 'Letter of intent is required.' };
  }

  if (!ALLOWED_LETTER_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
    return { ok: false, error: 'Letter of intent must be a PDF, DOC, DOCX, JPG, PNG, or WEBP file.' };
  }

  if (Number(file.size || 0) > MAX_LETTER_FILE_SIZE) {
    return { ok: false, error: 'Letter of intent exceeds the 5MB file size limit.' };
  }

  return { ok: true };
}

function handleUpload(req, res, next) {
  upload.single('letter_of_intent')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Letter of intent exceeds the 5MB file size limit.' });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload payload.' });
    }

    return res.status(400).json({ error: 'Invalid upload payload.' });
  });
}

async function uploadLetterOfIntent(file) {
  if (!file) return null;
  if (!cloudinary) {
    const error = new Error('Letter upload service is not configured.');
    error.code = 'UPLOAD_NOT_CONFIGURED';
    throw error;
  }

  return new Promise((resolve, reject) => {
    const safeOriginalFilename = String(file.originalname || 'letter-of-intent').slice(0, 255);
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'nogatu/stockist-applications',
        resource_type: 'auto',
        public_id: `letter-${Date.now()}-${safeOriginalFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url: result?.secure_url || null,
          publicId: result?.public_id || null,
          originalFilename: safeOriginalFilename,
          resourceType: result?.resource_type || null,
        });
      }
    );

    uploadStream.end(file.buffer);
  });
}

async function ensureApplicationsTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS distributor_applicationstab (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      age INT DEFAULT NULL,
      phone VARCHAR(50) NOT NULL,
      email VARCHAR(200) NOT NULL,
      letter_of_intent_url VARCHAR(500) DEFAULT NULL,
      letter_of_intent_public_id VARCHAR(255) DEFAULT NULL,
      letter_of_intent_filename VARCHAR(255) DEFAULT NULL,
      letter_of_intent_uploaded_at DATETIME DEFAULT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      follow_up_status ENUM('new','followed_up','cancelled','done') NOT NULL DEFAULT 'new',
      admin_note TEXT DEFAULT NULL,
      reviewed_by VARCHAR(100) DEFAULT NULL,
      reviewed_at DATETIME DEFAULT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_status (status),
      KEY idx_email_phone (email, phone),
      KEY idx_submitted_at (submitted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  await pool.query('ALTER TABLE distributor_applicationstab MODIFY age INT DEFAULT NULL').catch(() => {});
  await pool.query('ALTER TABLE distributor_applicationstab ADD COLUMN letter_of_intent_url VARCHAR(500) DEFAULT NULL AFTER email').catch(() => {});
  await pool.query('ALTER TABLE distributor_applicationstab ADD COLUMN letter_of_intent_public_id VARCHAR(255) DEFAULT NULL AFTER letter_of_intent_url').catch(() => {});
  await pool.query('ALTER TABLE distributor_applicationstab ADD COLUMN letter_of_intent_filename VARCHAR(255) DEFAULT NULL AFTER letter_of_intent_public_id').catch(() => {});
  await pool.query('ALTER TABLE distributor_applicationstab ADD COLUMN letter_of_intent_uploaded_at DATETIME DEFAULT NULL AFTER letter_of_intent_filename').catch(() => {});
  await pool.query(
    "ALTER TABLE distributor_applicationstab ADD COLUMN follow_up_status ENUM('new','followed_up','cancelled','done') NOT NULL DEFAULT 'new' AFTER status"
  ).catch(() => {});
}

router.post('/', applicationLimiter, handleUpload, async (req, res) => {
  try {
    await ensureApplicationsTable();

    const { name, phone, email } = normalizeApplicationFields(req.body);
    const fileValidation = validateLetterOfIntentFile(req.file);

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'Name, contact number, and email are required.' });
    }

    if (!fileValidation.ok) {
      return res.status(400).json({ error: fileValidation.error });
    }

    if (name.length > 150 || phone.length > 50 || email.length > 200) {
      return res.status(400).json({ error: 'One or more fields are too long.' });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const [recentRows] = await pool.query(
      `SELECT id, DATE_FORMAT(submitted_at, '%Y-%m-%d') AS submitted_at
       FROM distributor_applicationstab
       WHERE (email = ? OR phone = ?)
         AND submitted_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [email, phone]
    );

    if (recentRows.length > 0) {
      return res.status(429).json({
        error: 'An application was already submitted within the last 30 days. Please wait before re-applying.',
        lastSubmittedAt: recentRows[0].submitted_at,
      });
    }

    const uploadedLetter = await uploadLetterOfIntent(req.file);

    const [result] = await pool.query(
      `INSERT INTO distributor_applicationstab
       (name, phone, email, letter_of_intent_url, letter_of_intent_public_id, letter_of_intent_filename,
        letter_of_intent_uploaded_at, status, follow_up_status, ip_address, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), 'pending', 'new', ?, NOW())`,
      [name, phone, email, uploadedLetter?.url || null, uploadedLetter?.publicId || null, uploadedLetter?.originalFilename || null, req.ip || null]
    );

    res.json({
      success: true,
      id: Number(result.insertId || 0),
      message: 'Distributor application interest submitted.',
    });
  } catch (err) {
    console.error('[Applications] Submit error:', err);
    if (err.code === 'UPLOAD_NOT_CONFIGURED') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = {
  router,
  ensureApplicationsTable,
  normalizeApplicationFields,
  validateLetterOfIntentFile,
  uploadLetterOfIntent,
};
