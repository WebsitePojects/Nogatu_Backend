/**
 * Public contact form route
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../config/database');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ensureContactMessagesTable() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.CONTACT, 'Contact messages');
}

async function ensureContactBlocklistTable() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.CONTACT, 'Contact messages');
}

router.use(async (_req, res, next) => {
  try {
    await assertSchemaRequirements(SCHEMA_REQUIREMENTS.CONTACT, 'Contact messages');
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

async function isBlockedSender(email, ipAddress) {
  const emailVal = String(email || '').trim();
  const ipVal = String(ipAddress || '').trim();

  if (!emailVal && !ipVal) return false;

  if (emailVal && ipVal) {
    const [rows] = await pool.query(
      `SELECT id FROM contact_blockedtab
       WHERE active = 1 AND (email = ? OR ip_address = ?)
       LIMIT 1`,
      [emailVal, ipVal]
    );
    return rows.length > 0;
  }

  if (emailVal) {
    const [rows] = await pool.query(
      'SELECT id FROM contact_blockedtab WHERE active = 1 AND email = ? LIMIT 1',
      [emailVal]
    );
    return rows.length > 0;
  }

  const [rows] = await pool.query(
    'SELECT id FROM contact_blockedtab WHERE active = 1 AND ip_address = ? LIMIT 1',
    [ipVal]
  );
  return rows.length > 0;
}

/**
 * POST /api/contact
 */
router.post('/', contactLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();

    if (!name || !message) {
      return res.status(400).json({ error: 'Name and message are required' });
    }

    if (name.length > 150 || email.length > 200 || subject.length > 255 || message.length > 8000) {
      return res.status(400).json({ error: 'One or more fields are too long' });
    }

    if (email && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    await ensureContactMessagesTable();
    await ensureContactBlocklistTable();

    const blocked = await isBlockedSender(email, req.ip || null);
    if (blocked) {
      return res.status(403).json({
        error: 'Your message cannot be accepted at this time. Please contact support through other official channels.',
      });
    }

    const [result] = await pool.query(
      `INSERT INTO contact_messagestab
       (name, email, subject, message, status, ip_address, submitted_at)
       VALUES (?, ?, ?, ?, 0, ?, NOW())`,
      [name, email || null, subject || null, message, req.ip || null]
    );

    res.json({
      success: true,
      id: Number(result.insertId || 0),
      message: 'Thank you for contacting NOGATU',
    });
  } catch (err) {
    console.error('[Contact] Submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
