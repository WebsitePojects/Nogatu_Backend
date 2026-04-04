/**
 * Public contact form route
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../config/database');

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ensureContactMessagesTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS contact_messagestab (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(200) DEFAULT NULL,
      subject VARCHAR(255) DEFAULT NULL,
      message TEXT NOT NULL,
      status TINYINT NOT NULL DEFAULT 0,
      ip_address VARCHAR(45) DEFAULT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_status (status),
      KEY idx_submitted_at (submitted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
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
