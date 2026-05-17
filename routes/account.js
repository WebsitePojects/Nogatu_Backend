/**
 * Account Details Routes
 * 1:1 port of PHP account-details.php
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { normalizeEmail, isValidEmail } = require('../utils/email');
const { listPackagePolicies } = require('../services/packagePolicy');

let memberTinColumnsReady = false;
let memberHasTinNoColumn = false;

async function ensureMemberTinColumns() {
  if (memberTinColumnsReady) return;

  const [columns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'tin'");
  if (columns.length === 0) {
    await pool.query('ALTER TABLE memberstab ADD COLUMN tin VARCHAR(30) DEFAULT NULL');
  }

  const [tinNoColumns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'tinno'");
  memberHasTinNoColumn = tinNoColumns.length > 0;

  const [emailColumns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'email'");
  if (emailColumns.length === 0) {
    await pool.query('ALTER TABLE memberstab ADD COLUMN email VARCHAR(180) DEFAULT NULL');
  } else if (!String(emailColumns[0].Type || '').toLowerCase().includes('180')) {
    await pool.query('ALTER TABLE memberstab MODIFY COLUMN email VARCHAR(180) DEFAULT NULL');
  }

  memberTinColumnsReady = true;
}

router.get('/package-policies', memberAuth, async (_req, res) => {
  try {
    res.json({
      packages: listPackagePolicies(),
    });
  } catch (err) {
    console.error('[Account] Package policies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/account
 * Get member account details
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    await ensureMemberTinColumns();

    const uid = req.session.uid;
    const tinSelect = memberHasTinNoColumn
      ? 'COALESCE(m.tin, m.tinno) AS tin, m.tinno'
      : 'm.tin AS tin, NULL AS tinno';

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.datereg,
              m.uid as mUid, m.username, m.password, m.firstname, m.lastname,
              m.middlename, m.address, m.contactnos, m.payoutid, m.payoutdetails,
              m.email, m.fbaccount, m.gender, m.dob, ${tinSelect}
       FROM usertab u, memberstab m
       WHERE u.uid = m.uid AND u.uid = ?`,
      [uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = rows[0];
    const resolvedTin = user.tin || user.tinno || null;
    res.json({
      uid: user.uid,
      username: user.username,
      firstname: user.firstname,
      lastname: user.lastname,
      middlename: user.middlename,
      fullname: `${user.firstname} ${user.middlename || ''} ${user.lastname}`.trim(),
      address: user.address,
      contactnos: user.contactnos,
      email: user.email,
      emailRequired: !normalizeEmail(user.email),
      tin: resolvedTin,
      tinno: resolvedTin,
      payoutid: user.payoutid,
      payoutdetails: user.payoutdetails,
      accttype: user.currentaccttype,
      codeid: user.codeid,
      datereg: user.datereg,
    });
  } catch (err) {
    console.error('[Account] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/account
 * Update member account details
 * Mirrors PHP: UPDATE memberstab SET address, password, payoutdetails, payoutid, contactnos
 */
router.put('/', memberAuth, async (req, res) => {
  try {
    await ensureMemberTinColumns();

    const uid = req.session.uid;
    const { address, password, payoutdetails, payoutoptions, contactnos, tin, tinno, email } = req.body;

    const hasTinField = Object.prototype.hasOwnProperty.call(req.body, 'tin')
      || Object.prototype.hasOwnProperty.call(req.body, 'tinno');

    let normalizedTin = null;
    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid email address is required for password reset.' });
    }

    const [emailRows] = await pool.query(
      'SELECT uid FROM memberstab WHERE email = ? AND uid <> ? LIMIT 1',
      [normalizedEmail, uid]
    );
    if (emailRows.length > 0) {
      return res.status(400).json({ error: 'That email address is already being used by another account.' });
    }

    if (hasTinField) {
      normalizedTin = String(tin || tinno || '').trim();
      if (normalizedTin && (normalizedTin.length < 9 || normalizedTin.length > 30 || !/^[0-9-]+$/.test(normalizedTin))) {
        return res.status(400).json({ error: 'TIN must be 9-30 characters using digits and dashes only' });
      }
    }

    const setClauses = [
      'address = ?',
      'payoutdetails = ?',
      'payoutid = ?',
      'contactnos = ?',
      'email = ?',
    ];
    const values = [address, payoutdetails, payoutoptions, contactnos, normalizedEmail];

    if (password && password.trim()) {
      const hashedPassword = await bcrypt.hash(password, 12);
      setClauses.push('password = ?');
      values.push(hashedPassword);
    }

    if (hasTinField) {
      setClauses.push('tin = ?');
      values.push(normalizedTin || null);

      if (memberHasTinNoColumn) {
        setClauses.push('tinno = ?');
        values.push(normalizedTin || null);
      }
    }

    values.push(uid);

    await pool.query(
      `UPDATE memberstab SET ${setClauses.join(', ')}
       WHERE uid = ? LIMIT 1`,
      values
    );

    const [result] = await pool.query(
      'SELECT uid FROM memberstab WHERE uid = ?', [uid]
    );

    if (result.length > 0) {
      res.json({ success: true, message: 'Account updated successfully' });
    } else {
      res.status(400).json({ error: 'Update failed' });
    }
  } catch (err) {
    console.error('[Account] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
