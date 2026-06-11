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
const { resolveTin, isValidTin } = require('../utils/tin');
const { listPackagePolicies } = require('../services/packagePolicy');
const { normalizePayoutStorageValue, resolvePayoutOption, listPayoutOptions } = require('../services/payoutOptions');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

let memberTinColumnsReady = false;
let memberHasTinNoColumn = false;

async function ensureMemberTinColumns() {
  if (memberTinColumnsReady) return;

  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.MEMBER_PROFILE, 'Member account details');
  const [tinNoColumns] = await pool.query(
    `SELECT 1 AS ok
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'memberstab'
        AND column_name = 'tinno'
      LIMIT 1`
  );
  memberHasTinNoColumn = tinNoColumns.length > 0;
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
              m.uid as mUid, m.username, m.firstname, m.lastname,
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
      tinRequired: !resolvedTin,
      tin: resolvedTin,
      tinno: resolvedTin,
      payoutid: user.payoutid,
      payoutOption: resolvePayoutOption(user.payoutid, { allowUnknown: true }),
      payoutdetails: user.payoutdetails,
      payoutOptions: listPayoutOptions(),
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

    if (normalizedEmail && !isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'The email address format is invalid.' });
    }

    if (normalizedEmail) {
      const [emailRows] = await pool.query(
        'SELECT uid FROM memberstab WHERE email = ? AND uid <> ? LIMIT 1',
        [normalizedEmail, uid]
      );
      if (emailRows.length > 0) {
        return res.status(400).json({ error: 'That email address is already being used by another account.' });
      }
    }

    if (hasTinField) {
      normalizedTin = resolveTin({ tin, tinno });
      if (normalizedTin && !isValidTin(normalizedTin)) {
        return res.status(400).json({ error: 'TIN must contain 9-15 digits and will be saved in grouped format.' });
      }
    }

    const normalizedPayoutOption = normalizePayoutStorageValue(payoutoptions);

    const setClauses = [
      'address = ?',
      'payoutdetails = ?',
      'payoutid = ?',
      'contactnos = ?',
      'email = ?',
    ];
    const values = [address, payoutdetails, normalizedPayoutOption, contactnos, normalizedEmail || null];

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
