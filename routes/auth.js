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
const { writeAuditLog } = require('../services/audit');
const { normalizeEmail, isValidEmail } = require('../utils/email');

function normalizeLegacyUsername(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9 ]/g, '');
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
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
      `SELECT u.uid, u.public_uid, u.mainid, u.accttype, u.currentaccttype, u.cdstatus,
              u.codeid, DATE_FORMAT(u.datereg, '%Y-%m-%d') as datereg, u.position,
              u.account_status, u.account_status_reason,
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

    const accountStatus = String(user.account_status || 'active').trim().toLowerCase();
    if (accountStatus && accountStatus !== 'active') {
      return res.status(423).json({
        error: accountStatus === 'frozen'
          ? 'This account is frozen. Please contact support or your administrator.'
          : 'This account is suspended. Please contact support or your administrator.',
        accountStatus,
        reason: user.account_status_reason || null,
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((sessionErr) => {
        if (sessionErr) reject(sessionErr);
        else resolve();
      });
    });

    // Set session variables (mirrors PHP session exactly)
    req.session.uid = user.uid;
    req.session.publicUid = user.public_uid || null;
    req.session.username = user.username;
    req.session.accountname = `${user.firstname} ${user.lastname}`;
    req.session.shortname = user.firstname;
    req.session.accttype = user.accttype;
    req.session.currentaccttype = user.currentaccttype;
    req.session.caccttype = getAccountTypeName(user.currentaccttype);
    req.session.codeid = user.codeid;
    req.session.cdstatus = user.cdstatus;
    req.session.position = user.position;
    req.session.accountStatus = accountStatus || 'active';
    req.session.accountStatusReason = user.account_status_reason || null;
    delete req.session.adminid;
    delete req.session.adminname;
    delete req.session.adminrights;

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
        publicUid: user.public_uid || null,
        username: user.username,
        accountname: `${user.firstname} ${user.lastname}`,
        shortname: user.firstname,
        accttype: user.accttype,
        currentaccttype: user.currentaccttype,
        caccttype: getAccountTypeName(user.currentaccttype),
        codeid: user.codeid,
        cdstatus: user.cdstatus,
        position: user.position,
        accountStatus: accountStatus || 'active',
        accountStatusReason: user.account_status_reason || null,
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
 * POST /api/auth/forgot-password
 * Always returns 200 to avoid email/username enumeration.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter the email address saved on your account.' });
    }

    const [rows] = await pool.query(
      `SELECT uid, username, email, firstname, lastname
       FROM memberstab
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    if (rows.length > 0) {
      const member = rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      await pool.query(
        `INSERT INTO password_reset_tokenstab
         (member_uid, token_hash, expires_at, request_ip)
         VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 15 MINUTE), ?)`,
        [member.uid, tokenHash, req.ip || null]
      );

      await writeAuditLog({
        req,
        actorUid: member.uid,
        actorRole: 'member',
        action: 'auth.password_reset.request',
        targetUid: member.uid,
        targetTable: 'password_reset_tokenstab',
        afterState: { username: member.username },
      });

      // Email provider wiring is environment-specific. In development we return
      // the token so the local reset flow can be tested without a mail gateway.
      if (process.env.NODE_ENV !== 'production') {
        return res.json({
          success: true,
          message: 'If the account exists, reset instructions will be sent.',
          debugResetToken: rawToken,
        });
      }
    }

    res.json({ success: true, message: 'If the account exists, reset instructions will be sent.' });
  } catch (err) {
    console.error('[Auth] Forgot password error:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Password reset is not ready yet. Please run database migrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  let conn;
  try {
    const token = String(req.body.token || '').trim();
    const newPassword = String(req.body.newPassword || req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || req.body.confirm || newPassword);

    if (!token || !newPassword || newPassword !== confirmPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Enter a matching new password with at least 8 characters.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [tokenRows] = await conn.query(
      `SELECT id, member_uid
       FROM password_reset_tokenstab
       WHERE token_hash = ?
         AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP(6)
       LIMIT 1
       FOR UPDATE`,
      [hashResetToken(token)]
    );

    if (tokenRows.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    }

    const tokenRow = tokenRows[0];
    const hashed = await bcrypt.hash(newPassword, 12);
    await conn.query('UPDATE memberstab SET password = ? WHERE uid = ? LIMIT 1', [hashed, tokenRow.member_uid]);
    await conn.query('UPDATE password_reset_tokenstab SET used_at = CURRENT_TIMESTAMP(6) WHERE id = ? LIMIT 1', [tokenRow.id]);
    await conn.query('DELETE FROM app_sessions WHERE data LIKE ?', [`%"uid":${Number(tokenRow.member_uid)}%`]).catch(() => {});

    await writeAuditLog(conn, {
      req,
      actorUid: tokenRow.member_uid,
      actorRole: 'member',
      action: 'auth.password_reset.complete',
      targetUid: tokenRow.member_uid,
      targetTable: 'memberstab',
      targetId: String(tokenRow.member_uid),
    });

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Auth] Reset password error:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Password reset is not ready yet. Please run database migrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
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
        publicUid: req.session.publicUid || null,
        username: req.session.username,
        accountname: req.session.accountname,
        shortname: req.session.shortname,
        accttype: req.session.accttype,
        currentaccttype: req.session.currentaccttype,
        caccttype: req.session.caccttype,
        codeid: req.session.codeid,
        cdstatus: req.session.cdstatus,
        position: req.session.position,
        accountStatus: req.session.accountStatus || 'active',
        accountStatusReason: req.session.accountStatusReason || null,
      },
    });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
