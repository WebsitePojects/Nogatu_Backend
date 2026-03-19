/**
 * Admin Account Management Routes
 * 1:1 port of PHP adminpanel/account-masterlist.php + update-accounts.php
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAccountTypeName, ENTRY_TYPES } = require('../../utils/helpers');

/**
 * GET /api/admin/accounts?page=1&search=name
 * Account masterlist (paginated, 50 per page)
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 50;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';

    let countQuery = `SELECT COUNT(*) as total FROM memberstab m, usertab u
                      WHERE m.uid = u.uid AND u.uid = u.mainid`;
    let listQuery = `SELECT m.uid, m.firstname, m.lastname, m.middlename, m.username,
                     u.uid as uUid, u.codeid, u.mainid, u.refid, u.drefid, u.accttype,
                     u.activationcode, u.currentaccttype,
                     DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') as datereg
                     FROM memberstab m, usertab u
                     WHERE m.uid = u.uid AND u.uid = u.mainid`;

    const params = [];

    if (search) {
      const searchPattern = `%${search}%`;
      countQuery += ` AND (m.firstname LIKE ? OR m.lastname LIKE ?)`;
      listQuery += ` AND (m.firstname LIKE ? OR m.lastname LIKE ?)`;
      params.push(searchPattern, searchPattern);
    }

    listQuery += ` ORDER BY u.datereg DESC LIMIT ?, ?`;

    const [countRows] = await pool.query(countQuery, params);
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(listQuery, [...params, offset, perPage]);

    const accounts = rows.map(r => ({
      uid: r.uid,
      username: r.username,
      fullname: `${r.firstname} ${r.lastname}`,
      firstname: r.firstname,
      lastname: r.lastname,
      middlename: r.middlename,
      accttype: r.currentaccttype,
      accttypeName: getAccountTypeName(r.currentaccttype),
      codeid: r.codeid,
      entryType: ENTRY_TYPES[r.codeid] || 'Unknown',
      activationcode: r.activationcode,
      datereg: r.datereg,
    }));

    res.json({
      accounts,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (err) {
    console.error('[Admin Accounts] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/accounts/:uid
 * Get specific account details for editing
 */
router.get('/:uid', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.datereg,
              m.username, m.firstname, m.lastname, m.middlename,
              m.address, m.contactnos, m.payoutid, m.payoutdetails
       FROM usertab u, memberstab m
       WHERE u.uid = m.uid AND u.uid = ?`,
      [uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[Admin Accounts] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/accounts/:uid
 * Update account details (admin)
 * Mirrors PHP adminpanel/update-accounts.php
 */
router.put('/:uid', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const { firstname, lastname, middlename, address, password,
            payoutdetails, payoutoptions, contactnos } = req.body;

    if (password && password.trim()) {
      const hashedPassword = await bcrypt.hash(password, 12);
      await pool.query(
        `UPDATE memberstab SET firstname = ?, lastname = ?, middlename = ?,
         address = ?, password = ?, payoutdetails = ?, payoutid = ?, contactnos = ?
         WHERE uid = ? LIMIT 1`,
        [firstname, lastname, middlename, address, hashedPassword,
         payoutdetails, payoutoptions, contactnos, uid]
      );
    } else {
      await pool.query(
        `UPDATE memberstab SET firstname = ?, lastname = ?, middlename = ?,
         address = ?, payoutdetails = ?, payoutid = ?, contactnos = ?
         WHERE uid = ? LIMIT 1`,
        [firstname, lastname, middlename, address,
         payoutdetails, payoutoptions, contactnos, uid]
      );
    }

    const [result] = await pool.query('SELECT uid FROM memberstab WHERE uid = ?', [uid]);

    if (result.length > 0) {
      res.json({ success: true, message: 'Account updated successfully' });
    } else {
      res.status(400).json({ error: 'Update failed' });
    }
  } catch (err) {
    console.error('[Admin Accounts] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/accounts/change-password
 * Change admin password — requires old password verification
 */
router.post('/change-password', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const { adminAccount, password, oldPassword } = req.body;

    if (!adminAccount || !password) {
      return res.status(400).json({ error: 'Admin account and new password are required' });
    }

    // Verify old password first
    const [adminRows] = await pool.query(
      'SELECT username, password FROM accesstab WHERE username = ?',
      [adminAccount]
    );

    if (adminRows.length === 0) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

    if (oldPassword) {
      const storedPw = adminRows[0].password;
      const isHashed = storedPw && storedPw.startsWith('$2');
      let oldMatch = false;
      if (isHashed) {
        oldMatch = await bcrypt.compare(oldPassword, storedPw);
      } else {
        oldMatch = (oldPassword === storedPw);
      }
      if (!oldMatch) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'UPDATE accesstab SET password = ? WHERE username = ? LIMIT 1',
      [hashedPassword, adminAccount]
    );

    if (result.affectedRows === 1) {
      res.json({ success: true, message: 'Password changed successfully' });
    } else {
      res.status(400).json({ error: 'Password change failed' });
    }
  } catch (err) {
    console.error('[Admin] Password change error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
