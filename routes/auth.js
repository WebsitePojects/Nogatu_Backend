/**
 * Member Authentication Routes
 * 1:1 port of PHP ecom/index.php login logic
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { getAccountTypeName } = require('../utils/helpers');

function normalizeLegacyUsername(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9 ]/g, '');
}

/**
 * POST /api/auth/login
 * Mirrors PHP: SELECT from memberstab + usertab, set session variables
 */
router.post('/login', async (req, res) => {
  try {
    const username = normalizeLegacyUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const [rows] = await pool.query(
      `SELECT u.uid, u.mainid, u.accttype, u.currentaccttype, u.cdstatus,
              u.codeid, DATE_FORMAT(u.datereg, '%Y-%m-%d') as datereg, u.position,
              m.uid as mUid, m.username, m.password, m.firstname, m.lastname
       FROM memberstab m, usertab u
       WHERE m.uid = u.uid AND m.username = ?`,
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: 'Invalid username or password',
        ...(process.env.NODE_ENV !== 'production' ? { debugCode: 'USER_NOT_FOUND' } : {}),
      });
    }

    const user = rows[0];
    const storedPassword = String(user.password || '');

    // Compare password — supports both bcrypt hashed and legacy plaintext
    const isHashed = storedPassword.startsWith('$2');
    let passwordMatch = false;
    if (isHashed) {
      passwordMatch = await bcrypt.compare(password, storedPassword);
    } else {
      // Legacy plaintext comparison — use DB-side compare first (mirrors PHP behavior)
      const [plainRows] = await pool.query(
        'SELECT uid FROM memberstab WHERE username = ? AND password = ? LIMIT 1',
        [username, password]
      );
      passwordMatch = plainRows.length > 0 || password === storedPassword.trim();

      // Legacy hash compatibility (for datasets migrated from older auth flows).
      if (!passwordMatch && /^[a-f0-9]{32}$/i.test(storedPassword)) {
        const md5 = crypto.createHash('md5').update(password).digest('hex');
        passwordMatch = md5.toLowerCase() === storedPassword.toLowerCase();
      }
      if (!passwordMatch && /^[a-f0-9]{40}$/i.test(storedPassword)) {
        const sha1 = crypto.createHash('sha1').update(password).digest('hex');
        passwordMatch = sha1.toLowerCase() === storedPassword.toLowerCase();
      }

      // Auto-upgrade to bcrypt on successful legacy login.
      if (passwordMatch) {
        const hashed = await bcrypt.hash(password, 12);
        await pool.query('UPDATE memberstab SET password = ? WHERE uid = ?', [hashed, user.uid]);
      }
    }

    if (!passwordMatch) {
      return res.status(401).json({
        error: 'Invalid username or password',
        ...(process.env.NODE_ENV !== 'production' ? { debugCode: isHashed ? 'HASH_MISMATCH' : 'PLAINTEXT_MISMATCH' } : {}),
      });
    }

    // Set session variables (mirrors PHP session exactly)
    req.session.uid = user.uid;
    req.session.username = user.username;
    req.session.accountname = `${user.firstname} ${user.lastname}`;
    req.session.shortname = user.firstname;
    req.session.accttype = user.accttype;
    req.session.currentaccttype = user.currentaccttype;
    req.session.caccttype = getAccountTypeName(user.currentaccttype);
    req.session.codeid = user.codeid;
    req.session.cdstatus = user.cdstatus;
    req.session.position = user.position;

    await new Promise((resolve, reject) => {
      req.session.save((saveErr) => {
        if (saveErr) reject(saveErr);
        else resolve();
      });
    });

    res.json({
      success: true,
      user: {
        uid: user.uid,
        username: user.username,
        accountname: `${user.firstname} ${user.lastname}`,
        shortname: user.firstname,
        accttype: user.accttype,
        currentaccttype: user.currentaccttype,
        caccttype: getAccountTypeName(user.currentaccttype),
        codeid: user.codeid,
        cdstatus: user.cdstatus,
        position: user.position,
        datereg: user.datereg,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout
 * Mirrors PHP: session_destroy()
 */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

/**
 * GET /api/auth/session
 * Check current session status
 */
router.get('/session', (req, res) => {
  if (req.session && req.session.uid) {
    res.json({
      authenticated: true,
      user: {
        uid: req.session.uid,
        username: req.session.username,
        accountname: req.session.accountname,
        shortname: req.session.shortname,
        accttype: req.session.accttype,
        currentaccttype: req.session.currentaccttype,
        caccttype: req.session.caccttype,
        codeid: req.session.codeid,
        cdstatus: req.session.cdstatus,
        position: req.session.position,
      },
    });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
