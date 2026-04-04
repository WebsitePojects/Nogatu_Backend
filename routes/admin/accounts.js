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

const PACKAGE_MAP = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

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

    if (!adminAccount || !password || !oldPassword) {
      return res.status(400).json({ error: 'Admin account, current password, and new password are required' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    // Verify old password first
    const [adminRows] = await pool.query(
      'SELECT username, password FROM accesstab WHERE username = ?',
      [adminAccount]
    );

    if (adminRows.length === 0) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

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

async function handleIncomeDetails(req, res) {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(400).json({ error: 'Invalid account reference' });
    }

    const txPage = Math.max(1, Number(req.query.txPage) || 1);
    const txPerPage = Math.min(100, Math.max(1, Number(req.query.txPerPage) || 20));
    const txOffset = (txPage - 1) * txPerPage;

    const pairingPage = Math.max(1, Number(req.query.pairingPage) || 1);
    const pairingPerPage = Math.min(100, Math.max(1, Number(req.query.pairingPerPage) || 20));
    const pairingOffset = (pairingPage - 1) * pairingPerPage;

    // Member info
    const [memberRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username
       FROM memberstab m WHERE m.uid = ? LIMIT 1`,
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const member = memberRows[0];

    // Income transactions kept for backward compatibility with existing frontend.
    const [incomeTxRows] = await pool.query(
      `SELECT pid, transdate, beginningbalance, endingbalance,
              income1, income2, income3, income4, income5, income6
       FROM payouthistorytab
       WHERE uid = ? AND transactiontype = 1
       ORDER BY pid DESC`,
      [uid]
    );

    // Full transaction history with pagination.
    const [txCountRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM payouthistorytab WHERE uid = ?',
      [uid]
    );
    const txTotal = Number(txCountRows[0]?.total || 0);

    const [historyRows] = await pool.query(
      `SELECT pid,
              DATE_FORMAT(transdate, '%Y-%m-%d %H:%i') AS transdate,
              DATE_FORMAT(cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
              beginningbalance, endingbalance,
              income1, income2, income3, income4, income5, income6,
              encashment1, tax_1 AS tax, encashmentfee AS fee, cddeduction,
              transactiontype, cashstatus
       FROM payouthistorytab
       WHERE uid = ?
       ORDER BY pid DESC
       LIMIT ?, ?`,
      [uid, txOffset, txPerPage]
    );

    // Cumulative income totals
    const [totalsRows] = await pool.query(
      `SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6, ttlcashbalance
       FROM payouttotaltab WHERE uid = ? LIMIT 1`,
      [uid]
    );
    const totals = totalsRows[0] || {
      ttlincome1: 0,
      ttlincome2: 0,
      ttlincome3: 0,
      ttlincome4: 0,
      ttlincome5: 0,
      ttlincome6: 0,
      ttlcashbalance: 0,
    };

    // Direct referral contributors (paid accounts only).
    const [drefRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username,
              u.currentaccttype, u.datereg, u.directreferral
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.drefid = ? AND u.codeid = 1
       ORDER BY u.datereg DESC`,
      [uid]
    );

    // Upgrade referral contributors (transtype=1).
    const [upgradeRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username, u.currentaccttype,
              COALESCE(SUM(up.incentivepoints), 0) AS upgradeReferral,
              DATE_FORMAT(MAX(up.transdate), '%Y-%m-%d %H:%i') AS lastUpgradeDate
       FROM upgradetab up
       INNER JOIN usertab u ON u.uid = up.uid
       INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.drefid = ? AND up.transtype = 1
       GROUP BY up.uid, m.firstname, m.lastname, m.username, u.currentaccttype
       ORDER BY MAX(up.transdate) DESC`,
      [uid]
    );

    // Binary pair direct children (position 1=Left, 2=Right)
    const [pairRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username, u.currentaccttype, u.position
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.refid = ? LIMIT 2`,
      [uid]
    );

    // Leadership binary downline L1-L3.
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

    // Pairing history records for audit/detail section.
    const [pairingCountRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM pairingstab WHERE uid = ?',
      [uid]
    );
    const pairingTotal = Number(pairingCountRows[0]?.total || 0);

    const [pairingRows] = await pool.query(
      `SELECT DATE_FORMAT(transdate, '%Y-%m-%d') AS transdate,
              weeknumber,
              \`left\`, \`right\`,
              totalpoints, totalbpay,
              totalleft, totalright,
              totalpointsleft, totalpointsright
       FROM pairingstab
       WHERE uid = ?
       ORDER BY transdate DESC, id DESC
       LIMIT ?, ?`,
      [uid, pairingOffset, pairingPerPage]
    );

    const directReferrals = drefRows.map(r => ({
      name: `${r.firstname} ${r.lastname}`,
      username: r.username,
      pkg: PACKAGE_MAP[r.currentaccttype] || '',
      datereg: r.datereg,
      directReferralAmount: Number(r.directreferral || 0),
    }));

    const upgradeReferralContributors = upgradeRows.map(r => ({
      name: `${r.firstname} ${r.lastname}`,
      username: r.username,
      pkg: PACKAGE_MAP[r.currentaccttype] || '',
      upgradeReferralAmount: Number(r.upgradeReferral || 0),
      lastUpgradeDate: r.lastUpgradeDate,
    }));

    const directReferralContributorTotal =
      directReferrals.reduce((sum, r) => sum + Number(r.directReferralAmount || 0), 0) +
      upgradeReferralContributors.reduce((sum, r) => sum + Number(r.upgradeReferralAmount || 0), 0);

    const transactionHistory = historyRows.map(r => {
      const incomeTotal =
        Number(r.income1 || 0) +
        Number(r.income2 || 0) +
        Number(r.income3 || 0) +
        Number(r.income4 || 0) +
        Number(r.income5 || 0) +
        Number(r.income6 || 0);
      const deductions = Number(r.tax || 0) + Number(r.fee || 0) + Number(r.cddeduction || 0);

      return {
        pid: r.pid,
        transdate: r.transdate,
        cashtransdate: r.cashtransdate,
        transactionType: Number(r.transactiontype || 0),
        transactionTypeName:
          Number(r.transactiontype || 0) === 1
            ? 'Income'
            : Number(r.transactiontype || 0) === 10
              ? 'Encashment'
              : 'Other',
        status: Number(r.cashstatus || 0),
        beginningbalance: Number(r.beginningbalance || 0),
        endingbalance: Number(r.endingbalance || 0),
        income1: Number(r.income1 || 0),
        income2: Number(r.income2 || 0),
        income3: Number(r.income3 || 0),
        income4: Number(r.income4 || 0),
        income5: Number(r.income5 || 0),
        income6: Number(r.income6 || 0),
        totalIncome: incomeTotal,
        encashment: Number(r.encashment1 || 0),
        tax: Number(r.tax || 0),
        fee: Number(r.fee || 0),
        cdDeduction: Number(r.cddeduction || 0),
        deductions,
        netAmount:
          Number(r.transactiontype || 0) === 10
            ? Number(r.encashment1 || 0)
            : incomeTotal,
      };
    });

    res.json({
      member: {
        uid,
        username: member.username,
        fullname: `${member.firstname} ${member.lastname}`,
      },
      totals: {
        ttlincome1: Number(totals.ttlincome1 || 0),
        ttlincome2: Number(totals.ttlincome2 || 0),
        ttlincome3: Number(totals.ttlincome3 || 0),
        ttlincome4: Number(totals.ttlincome4 || 0),
        ttlincome5: Number(totals.ttlincome5 || 0),
        ttlincome6: Number(totals.ttlincome6 || 0),
        ttlcashbalance: Number(totals.ttlcashbalance || 0),
      },
      // Backward-compatible key consumed by existing UI.
      transactions: incomeTxRows.map(r => ({
        pid: r.pid,
        transdate: r.transdate,
         beginningbalance: Number(r.beginningbalance || 0),
         endingbalance: Number(r.endingbalance || 0),
         income1: Number(r.income1 || 0),
         income2: Number(r.income2 || 0),
         income3: Number(r.income3 || 0),
         income4: Number(r.income4 || 0),
         income5: Number(r.income5 || 0),
         income6: Number(r.income6 || 0),
         total: Number(r.income1 || 0) + Number(r.income2 || 0) + Number(r.income3 || 0) +
           Number(r.income4 || 0) + Number(r.income5 || 0) + Number(r.income6 || 0),
      })),
      transactionHistory,
      transactionPagination: {
        page: txPage,
        perPage: txPerPage,
        total: txTotal,
        totalPages: Math.max(1, Math.ceil(txTotal / txPerPage)),
      },
      directReferrals,
      directReferralContributors: directReferrals,
      upgradeReferralContributors,
      directReferralComputedTotal: directReferralContributorTotal,
      binaryChildren: pairRows.map(r => ({
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: PACKAGE_MAP[r.currentaccttype] || '',
        side: Number(r.position || 0) === 1 ? 'Left' : 'Right',
      })),
      leadershipDownline: ldrsRows.map(r => ({
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: PACKAGE_MAP[r.currentaccttype] || '',
        lvl: r.lvl,
      })),
      pairingRecords: pairingRows.map(r => ({
        transdate: r.transdate,
        weeknumber: Number(r.weeknumber || 0),
        left: Number(r.left || 0),
        right: Number(r.right || 0),
        totalpoints: Number(r.totalpoints || 0),
        totalbpay: Number(r.totalbpay || 0),
        totalleft: Number(r.totalleft || 0),
        totalright: Number(r.totalright || 0),
        totalpointsleft: Number(r.totalpointsleft || 0),
        totalpointsright: Number(r.totalpointsright || 0),
      })),
      pairingPagination: {
        page: pairingPage,
        perPage: pairingPerPage,
        total: pairingTotal,
        totalPages: Math.max(1, Math.ceil(pairingTotal / pairingPerPage)),
      },
    });
  } catch (err) {
    console.error('[Admin Accounts] Income details error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/accounts/:uid/income
 * GET /api/admin/accounts/:uid/income-details
 * Income transaction details for a member
 */
router.get('/:uid/income', adminAuth, adminRights([1, 3]), handleIncomeDetails);
router.get('/:uid/income-details', adminAuth, adminRights([1, 3]), handleIncomeDetails);

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
