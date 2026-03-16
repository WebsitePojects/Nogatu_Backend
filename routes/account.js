/**
 * Account Details Routes
 * 1:1 port of PHP account-details.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');

/**
 * GET /api/account
 * Get member account details
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.datereg,
              m.uid as mUid, m.username, m.password, m.firstname, m.lastname,
              m.middlename, m.address, m.contactnos, m.payoutid, m.payoutdetails,
              m.email, m.fbaccount, m.gender, m.dob
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
      payoutid: user.payoutid,
      payoutdetails: user.payoutdetails,
      password: user.password,
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
    const uid = req.session.uid;
    const { address, password, payoutdetails, payoutoptions, contactnos } = req.body;

    const [result] = await pool.query(
      `UPDATE memberstab SET address = ?, password = ?,
       payoutdetails = ?, payoutid = ?, contactnos = ?
       WHERE uid = ? LIMIT 1`,
      [address, password, payoutdetails, payoutoptions, contactnos, uid]
    );

    if (result.affectedRows === 1) {
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
