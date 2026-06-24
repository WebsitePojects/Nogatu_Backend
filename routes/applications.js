const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../config/database');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many application submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function normalizeApplicationFields(body = {}) {
  return {
    name: String(body?.name || '').trim(),
    sponsorName: String(body?.sponsorName || '').trim(),
    phone: String(body?.phone || '').trim(),
    email: String(body?.email || '').trim().toLowerCase(),
  };
}

async function ensureApplicationsTable() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.APPLICATIONS, 'Distributor applications');
}

router.use(async (_req, res, next) => {
  try {
    await assertSchemaRequirements(SCHEMA_REQUIREMENTS.APPLICATIONS, 'Distributor applications');
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

router.post('/', applicationLimiter, async (req, res) => {
  try {
    await ensureApplicationsTable();

    const { name, sponsorName, phone, email } = normalizeApplicationFields(req.body);

    if (!name || !sponsorName || !phone || !email) {
      return res.status(400).json({ error: 'Name, sponsor full name, contact number, and email are required.' });
    }

    if (name.length > 150 || sponsorName.length > 150 || phone.length > 50 || email.length > 200) {
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

    const [result] = await pool.query(
      `INSERT INTO distributor_applicationstab
       (name, sponsor_name, phone, email, letter_of_intent_url, letter_of_intent_public_id, letter_of_intent_filename,
        letter_of_intent_uploaded_at, status, follow_up_status, ip_address, submitted_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', 'new', ?, NOW())`,
      [name, sponsorName, phone, email, req.ip || null]
    );

    res.json({
      success: true,
      id: Number(result.insertId || 0),
      message: 'Distributor inquiry submitted successfully.',
    });
  } catch (err) {
    console.error('[Applications] Submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = {
  router,
  ensureApplicationsTable,
  normalizeApplicationFields,
};
