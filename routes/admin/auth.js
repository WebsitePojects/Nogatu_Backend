/**
 * Admin Authentication Routes
 * 1:1 port of PHP adminpanel/index.php login logic
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');

/**
 * POST /api/admin/auth/login
 * Admin login with role-based access
 * Rights: 1=Administrator, 2=Cashier, 3=BOD
 */
router.post('/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const [rows] = await pool.query(
      'SELECT id, username, password, name, rights FROM accesstab WHERE username = ? AND password = ?',
      [username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const admin = rows[0];

    req.session.adminid = admin.username;
    req.session.adminname = admin.name;
    req.session.adminrights = admin.rights;

    await new Promise((resolve, reject) => {
      req.session.save((saveErr) => {
        if (saveErr) reject(saveErr);
        else resolve();
      });
    });

    res.json({
      success: true,
      admin: {
        username: admin.username,
        name: admin.name,
        rights: admin.rights,
        rightsName: admin.rights === 1 ? 'Administrator' : admin.rights === 2 ? 'Cashier' : 'BOD',
      },
    });
  } catch (err) {
    console.error('[Admin Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/auth/logout
 */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

/**
 * GET /api/admin/auth/session
 */
router.get('/session', (req, res) => {
  if (req.session && req.session.adminid) {
    res.json({
      authenticated: true,
      admin: {
        username: req.session.adminid,
        name: req.session.adminname,
        rights: req.session.adminrights,
      },
    });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
