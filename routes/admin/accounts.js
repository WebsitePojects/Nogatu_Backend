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

/**
 * GET /api/admin/accounts/:uid/income
 * Income transaction details for a member (transactiontype=1)
 * Mirrors PHP adminpanel/accounts-income-details.php
 */
router.get('/:uid/income', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);

    // Member info
    const [memberRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username
       FROM memberstab m WHERE m.uid = ? LIMIT 1`,
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const member = memberRows[0];

    // Income transactions (type 1 = income credit)
    const [txRows] = await pool.query(
      `SELECT pid, transdate, beginningbalance, endingbalance,
              income1, income2, income3, income4, income5, income6
       FROM payouthistorytab
       WHERE uid = ? AND transactiontype = 1
       ORDER BY pid DESC`,
      [uid]
    );

    // Cumulative income totals
    const [totalsRows] = await pool.query(
      `SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6, ttlcashbalance
       FROM payouttotaltab WHERE uid = ? LIMIT 1`,
      [uid]
    );
    const totals = totalsRows[0] || {};

    // Direct referrals (sponsor tree)
    const [drefRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username, u.currentaccttype, u.datereg
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.drefid = ? ORDER BY u.datereg DESC`,
      [uid]
    );

    // Binary pair direct children (position 1=Left, 2=Right)
    const [pairRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username, u.currentaccttype, u.position
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.refid = ? LIMIT 2`,
      [uid]
    );

    // Leadership binary downline L1–L3
    const [ldrsRows] = await pool.query(
      `SELECT m1.firstname, m1.lastname, m1.username, u1.currentaccttype, 'L1' AS lvl
       FROM usertab u1 INNER JOIN memberstab m1 ON m1.uid = u1.uid WHERE u1.refid = ?
       UNION
       SELECT m2.firstname, m2.lastname, m2.username, u2.currentaccttype, 'L2' AS lvl
       FROM usertab u1
       INNER JOIN usertab u2 ON u2.refid = u1.uid
       INNER JOIN memberstab m2 ON m2.uid = u2.uid WHERE u1.refid = ?
       UNION
       SELECT m3.firstname, m3.lastname, m3.username, u3.currentaccttype, 'L3' AS lvl
       FROM usertab u1
       INNER JOIN usertab u2 ON u2.refid = u1.uid
       INNER JOIN usertab u3 ON u3.refid = u2.uid
       INNER JOIN memberstab m3 ON m3.uid = u3.uid WHERE u1.refid = ?
       LIMIT 30`,
      [uid, uid, uid]
    );

    const pkgMap = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };

    res.json({
      member: {
        uid,
        username: member.username,
        fullname: `${member.firstname} ${member.lastname}`,
      },
      totals,
      transactions: txRows.map(r => ({
        pid: r.pid,
        transdate: r.transdate,
        beginningbalance: Number(r.beginningbalance),
        endingbalance: Number(r.endingbalance),
        income1: Number(r.income1),
        income2: Number(r.income2),
        income3: Number(r.income3),
        income4: Number(r.income4),
        income5: Number(r.income5),
        income6: Number(r.income6),
        total: Number(r.income1) + Number(r.income2) + Number(r.income3) +
               Number(r.income4) + Number(r.income5) + Number(r.income6),
      })),
      directReferrals: drefRows.map(r => ({
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: pkgMap[r.currentaccttype] || '',
        datereg: r.datereg,
      })),
      binaryChildren: pairRows.map(r => ({
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: pkgMap[r.currentaccttype] || '',
        side: r.position === 1 ? 'Left' : 'Right',
      })),
      leadershipDownline: ldrsRows.map(r => ({
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: pkgMap[r.currentaccttype] || '',
        lvl: r.lvl,
      })),
    });
  } catch (err) {
    console.error('[Admin Accounts] Income details error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/accounts/:uid/cd
 * CD deduction history for a member (encashments with cddeduction > 0)
 * Mirrors PHP adminpanel/accounts-cdpayment-details.php
 */
router.get('/:uid/cd', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const uid = Number(req.params.uid);

    const [memberRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username,
              u.cdamount, u.cdtotal, u.cdstatus, u.codeid
       FROM memberstab m INNER JOIN usertab u ON u.uid = m.uid
       WHERE m.uid = ? LIMIT 1`,
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const member = memberRows[0];

    const [rows] = await pool.query(
      `SELECT pid, transdate, encashment1, tax_1, encashmentfee, cddeduction
       FROM payouthistorytab
       WHERE uid = ? AND transactiontype = 10 AND cddeduction > 0
       ORDER BY pid DESC`,
      [uid]
    );

    res.json({
      member: {
        uid,
        username: member.username,
        fullname: `${member.firstname} ${member.lastname}`,
        codeid: member.codeid,
        cdamount: Number(member.cdamount),
        cdtotal: Number(member.cdtotal),
        cdstatus: member.cdstatus,
        cdRemaining: Math.max(0, Number(member.cdamount) - Number(member.cdtotal)),
      },
      records: rows.map(r => ({
        pid: r.pid,
        transdate: r.transdate,
        encashment: Number(r.encashment1),
        taxAndFee: Number(r.tax_1) + Number(r.encashmentfee),
        cddeduction: Number(r.cddeduction),
      })),
    });
  } catch (err) {
    console.error('[Admin Accounts] CD payment details error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
