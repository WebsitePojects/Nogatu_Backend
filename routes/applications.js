const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../config/database');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many application submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function ensureApplicationsTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS distributor_applicationstab (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      age INT DEFAULT NULL,
      phone VARCHAR(50) NOT NULL,
      email VARCHAR(200) NOT NULL,
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
  await pool.query(
    "ALTER TABLE distributor_applicationstab ADD COLUMN follow_up_status ENUM('new','followed_up','cancelled','done') NOT NULL DEFAULT 'new' AFTER status"
  ).catch(() => {});
}

router.post('/', applicationLimiter, async (req, res) => {
  try {
    await ensureApplicationsTable();

    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'Name, contact number, and email are required.' });
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

    const [result] = await pool.query(
      `INSERT INTO distributor_applicationstab
       (name, phone, email, status, follow_up_status, ip_address, submitted_at)
       VALUES (?, ?, ?, 'pending', 'new', ?, NOW())`,
      [name, phone, email, req.ip || null]
    );

    res.json({
      success: true,
      id: Number(result.insertId || 0),
      message: 'Distributor application interest submitted.',
    });
  } catch (err) {
    console.error('[Applications] Submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router, ensureApplicationsTable };
