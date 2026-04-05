/**
 * Account Details Routes
 * 1:1 port of PHP account-details.php
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { resolveTin, isValidTin } = require('../utils/tin');

let memberTinColumnReady = false;

async function ensureMemberTinColumn() {
  if (memberTinColumnReady) return;

  const [columns] = await pool.query("SHOW COLUMNS FROM memberstab LIKE 'tin'");
  if (columns.length === 0) {
    await pool.query('ALTER TABLE memberstab ADD COLUMN tin VARCHAR(30) DEFAULT NULL');
  }

  memberTinColumnReady = true;
}

/**
 * GET /api/account
 * Get member account details
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    await ensureMemberTinColumn();

    const uid = req.session.uid;

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.datereg,
              m.uid as mUid, m.username, m.password, m.firstname, m.lastname,
              m.middlename, m.address, m.contactnos, m.payoutid, m.payoutdetails,
              m.email, m.fbaccount, m.gender, m.dob, m.tin
       FROM usertab u, memberstab m
       WHERE u.uid = m.uid AND u.uid = ?`,
      [uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = rows[0];
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
      tin: user.tin || null,
      tinno: user.tin || null,
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
    await ensureMemberTinColumn();

    const uid = req.session.uid;
    const { address, password, payoutdetails, payoutoptions, contactnos } = req.body;

    const hasTinField = Object.prototype.hasOwnProperty.call(req.body, 'tin')
      || Object.prototype.hasOwnProperty.call(req.body, 'tinno');
    const normalizedTin = resolveTin(req.body);

    if (hasTinField && normalizedTin && !isValidTin(normalizedTin)) {
      return res.status(400).json({ error: 'TIN must be 9-30 characters using digits and dashes only' });
    }

    const setClauses = [
      'address = ?',
      'payoutdetails = ?',
      'payoutid = ?',
      'contactnos = ?',
    ];
    const values = [address, payoutdetails, payoutoptions, contactnos];

    if (hasTinField) {
      setClauses.push('tin = ?');
      values.push(normalizedTin || null);
    }

    if (password && password.trim()) {
      const hashedPassword = await bcrypt.hash(password, 12);
      setClauses.push('password = ?');
      values.push(hashedPassword);
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
