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
const { getLeadershipTraceability } = require('../../services/income/leadership');
const { getPairingTrace } = require('../../services/income/pairingTracker');
const { getEffectiveAccountState, getAccountEntryAuditInfo } = require('../../services/accountState');
const { writeAuditLog } = require('../../services/audit');
const { resolveTin, isValidTin } = require('../../utils/tin');
const { normalizePayoutStorageValue, resolvePayoutOption, listPayoutOptions } = require('../../services/payoutOptions');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../../services/schemaReadiness');

const PACKAGE_MAP = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

let tinColumnsChecked = false;
let memberHasTinNoColumn = false;

async function ensureMemberTinColumns() {
  if (tinColumnsChecked) return;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.MEMBER_PROFILE, 'Admin account management');
  const [tinNoRows] = await pool.query(
    `SELECT 1 AS ok
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'memberstab'
        AND column_name = 'tinno'
      LIMIT 1`
  );
  memberHasTinNoColumn = tinNoRows.length > 0;
  tinColumnsChecked = true;
}

function buildRegistrationRangeClause(range = 'all') {
  if (range === 'week') {
    return ` AND u.datereg >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
  }
  if (range === 'month') {
    return ` AND MONTH(u.datereg) = MONTH(NOW()) AND YEAR(u.datereg) = YEAR(NOW())`;
  }
  return '';
}

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
    const monitorPage = Math.max(1, Number(req.query.monitorPage) || 1);
    const monitorPerPage = 25;
    const monitorOffset = (monitorPage - 1) * monitorPerPage;
    const monitorRange = String(req.query.monitorRange || 'all').trim().toLowerCase();
    const monitorSort = String(req.query.monitorSort || 'newest').trim().toLowerCase() === 'oldest'
      ? 'ASC'
      : 'DESC';

    let countQuery = `SELECT COUNT(*) as total FROM memberstab m, usertab u
                      WHERE m.uid = u.uid AND u.uid = u.mainid`;
    let listQuery = `SELECT m.uid, m.firstname, m.lastname, m.middlename, m.username,
                     u.uid as uUid, u.codeid, u.mainid, u.refid, u.drefid, u.accttype,
                     u.activationcode, u.currentaccttype, u.account_status, u.account_status_reason,
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

    const monitorWhere = `
      FROM memberstab m
      INNER JOIN usertab u ON m.uid = u.uid
      WHERE u.uid = u.mainid
      ${buildRegistrationRangeClause(monitorRange)}
      ${search ? `AND (m.firstname LIKE ? OR m.lastname LIKE ? OR m.username LIKE ?)` : ''}
    `;

    const monitorParams = [];
    if (search) {
      const searchPattern = `%${search}%`;
      monitorParams.push(searchPattern, searchPattern, searchPattern);
    }

    const [
      [countRows],
      [monitorCountRows],
      [rangeCountRows],
      [rows],
      [monitorRows],
    ] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(`SELECT COUNT(*) AS total ${monitorWhere}`, monitorParams),
      pool.query(
        `SELECT
            SUM(CASE WHEN u.datereg >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS weekly,
            SUM(CASE WHEN MONTH(u.datereg) = MONTH(NOW()) AND YEAR(u.datereg) = YEAR(NOW()) THEN 1 ELSE 0 END) AS monthly
         FROM usertab u
         WHERE u.uid = u.mainid`
      ),
      pool.query(listQuery, [...params, offset, perPage]),
      pool.query(
        `SELECT
            m.uid, m.username, m.firstname, m.lastname, m.middlename,
            u.currentaccttype, u.codeid, u.account_status,
            DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg
         ${monitorWhere}
         ORDER BY u.datereg ${monitorSort}, m.uid ${monitorSort}
         LIMIT ?, ?`,
        [...monitorParams, monitorOffset, monitorPerPage]
      ),
    ]);

    const total = Number(countRows.total);
    const monitorTotal = Number(monitorCountRows.total || 0);
    const rangeCounts = rangeCountRows || { weekly: 0, monthly: 0 };

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
      accountStatus: String(r.account_status || 'active').toLowerCase(),
      accountStatusReason: r.account_status_reason || null,
    }));

    const monitoringAccounts = monitorRows.map((r) => ({
      uid: r.uid,
      username: r.username,
      fullname: `${r.firstname} ${r.lastname}`.trim(),
      firstname: r.firstname,
      lastname: r.lastname,
      middlename: r.middlename,
      accttype: r.currentaccttype,
      accttypeName: getAccountTypeName(r.currentaccttype),
      entryType: ENTRY_TYPES[r.codeid] || 'Unknown',
      datereg: r.datereg,
      accountStatus: String(r.account_status || 'active').toLowerCase() === 'frozen'
        ? 'frozen'
        : String(r.account_status || 'active').toLowerCase(),
    }));

    res.json({
      accounts,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
      monitoring: {
        range: monitorRange,
        sort: monitorSort === 'ASC' ? 'oldest' : 'newest',
        page: monitorPage,
        perPage: monitorPerPage,
        total: monitorTotal,
        totalPages: Math.max(1, Math.ceil(monitorTotal / monitorPerPage)),
        weeklyRegistrations: Number(rangeCounts.weekly || 0),
        monthlyRegistrations: Number(rangeCounts.monthly || 0),
        accounts: monitoringAccounts,
      },
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
    await ensureMemberTinColumns();
    const uid = Number(req.params.uid);
    const tinSelect = memberHasTinNoColumn
      ? 'COALESCE(m.tin, m.tinno) AS tin, m.tinno'
      : 'm.tin AS tin, NULL AS tinno';

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.datereg,
              u.account_status, u.account_status_reason,
              m.username, m.firstname, m.lastname, m.middlename,
              m.address, m.contactnos, ${tinSelect}, m.payoutid, m.payoutdetails
       FROM usertab u, memberstab m
       WHERE u.uid = m.uid AND u.uid = ?`,
      [uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const row = rows[0];
    const resolvedTin = row.tin || row.tinno || null;

    res.json({
      ...row,
      tin: resolvedTin,
      tinno: resolvedTin,
      payoutOption: resolvePayoutOption(row.payoutid, { allowUnknown: true }),
      payoutOptions: listPayoutOptions(),
      account_status: String(row.account_status || 'active').toLowerCase(),
      account_status_reason: row.account_status_reason || null,
    });
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
    await ensureMemberTinColumns();
    const uid = Number(req.params.uid);
    const { firstname, lastname, middlename, address, password,
            payoutdetails, payoutoptions, contactnos, tin, tinno } = req.body;

    const hasTinField = Object.prototype.hasOwnProperty.call(req.body, 'tin')
      || Object.prototype.hasOwnProperty.call(req.body, 'tinno');

    let normalizedTin = null;
    if (hasTinField) {
      normalizedTin = resolveTin({ tin, tinno });
      if (normalizedTin && !isValidTin(normalizedTin)) {
        return res.status(400).json({ error: 'TIN must contain 9-15 digits and will be saved in grouped format.' });
      }
    }

    const normalizedPayoutOption = normalizePayoutStorageValue(payoutoptions);

    const setClauses = [
      'firstname = ?',
      'lastname = ?',
      'middlename = ?',
      'address = ?',
      'payoutdetails = ?',
      'payoutid = ?',
      'contactnos = ?',
    ];
    const values = [
      firstname,
      lastname,
      middlename,
      address,
      payoutdetails,
      normalizedPayoutOption,
      contactnos,
    ];

    if (hasTinField) {
      setClauses.push('tin = ?');
      values.push(normalizedTin || null);
    }

    if (password && password.trim()) {
      const hashedPassword = await bcrypt.hash(password, 12);
      setClauses.push('password = ?');
      values.push(hashedPassword);
    }

    if (hasTinField && memberHasTinNoColumn) {
      setClauses.push('tinno = ?');
      values.push(normalizedTin || null);
    }

    values.push(uid);

    await pool.query(
      `UPDATE memberstab SET ${setClauses.join(', ')}
       WHERE uid = ? LIMIT 1`,
      values
    );

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

router.put('/:uid/status', adminAuth, adminRights([1, 3]), async (req, res) => {
  let conn;
  try {
    const uid = Number(req.params.uid);
    const nextStatus = String(req.body?.status || '').trim().toLowerCase();
    const reason = String(req.body?.reason || '').trim();

    if (!['active', 'suspended', 'frozen'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid account status' });
    }

    if (nextStatus !== 'active' && !reason) {
      return res.status(400).json({ error: 'Reason is required for suspension or freeze.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT uid, account_status, account_status_reason
         FROM usertab
        WHERE uid = ?
        LIMIT 1
        FOR UPDATE`,
      [uid]
    );

    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Account not found' });
    }

    const before = rows[0];
    await conn.query(
      `UPDATE usertab
          SET account_status = ?,
              account_status_reason = ?,
              account_status_changed_at = NOW(),
              account_status_changed_by = ?
        WHERE uid = ?
        LIMIT 1`,
      [
        nextStatus,
        nextStatus === 'active' ? null : reason,
        Number(req.session.adminid || 0) || null,
        uid,
      ]
    );

    if (nextStatus !== 'active') {
      await conn.query(
        'DELETE FROM app_sessions WHERE data LIKE ?',
        [`%"uid":${uid}%`]
      ).catch(() => {});
    }

    await writeAuditLog(conn, {
      req,
      actorUid: Number(req.session.adminid || 0) || null,
      actorRole: 'admin',
      action: 'account.status_update',
      targetUid: uid,
      targetTable: 'usertab',
      targetId: String(uid),
      beforeState: {
        accountStatus: String(before.account_status || 'active').toLowerCase(),
        accountStatusReason: before.account_status_reason || null,
      },
      afterState: {
        accountStatus: nextStatus,
        accountStatusReason: nextStatus === 'active' ? null : reason,
      },
    });

    await conn.commit();
    res.json({
      success: true,
      accountStatus: nextStatus,
      accountStatusReason: nextStatus === 'active' ? null : reason,
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Admin Accounts] Status update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
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
      `SELECT m.firstname, m.lastname, m.username,
              u.accttype, u.currentaccttype
         FROM memberstab m
         INNER JOIN usertab u ON u.uid = m.uid
       WHERE m.uid = ? LIMIT 1`,
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

    // Direct referral contributors across all package-entry slots.
    const [drefRows] = await pool.query(
      `SELECT m.firstname, m.lastname, m.username,
              u.uid, u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
              u.datereg, u.directreferral
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
       WHERE u.drefid = ?
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

    const leadershipTrace = await getLeadershipTraceability(uid);
    const pairingTrace = await getPairingTrace(uid, Number(member.currentaccttype || member.accttype || 0), { limit: 50 }).catch((error) => {
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return {
          rows: [],
          summary: {
            totalEvents: 0,
            totalPairPoints: 0,
            totalGrossIncome: 0,
            totalCreditedIncome: 0,
            cappedEvents: 0,
            uncappedEvents: 0,
          },
          weeklyCap: 0,
          packageName: null,
          sourceBackfill: { inserted: 0, skipped: 0 },
        };
      }
      throw error;
    });

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

    const directReferrals = await Promise.all(drefRows.map(async (r) => {
      const effectiveRow = await getEffectiveAccountState(r.uid, r);
      const auditInfo = getAccountEntryAuditInfo(effectiveRow || r);
      return {
        name: `${r.firstname} ${r.lastname}`,
        username: r.username,
        pkg: PACKAGE_MAP[effectiveRow?.currentaccttype || r.currentaccttype] || '',
        datereg: r.datereg,
        directReferralAmount: Number(effectiveRow?.directreferral || r.directreferral || 0),
        entryType: auditInfo.entryLabel,
        entryCode: auditInfo.entryCode,
        sponsorCreditEligible: Boolean(auditInfo.sponsorCreditEligible),
        sourceBinaryEligible: Boolean(auditInfo.sourceBinaryEligible),
      };
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
      leadershipDownline: leadershipTrace.rows.map(r => ({
        name: r.fullName,
        username: r.username,
        lvl: `L${r.level}`,
        ratePercent: Number(r.ratePercent || 0),
        sourcePairingIncome: Number(r.pairingIncome || 0),
        leadershipBonus: Number(r.leadershipBonus || 0),
        directReferralCount: Number(r.directReferralCount || 0),
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
      pairingTrace,
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
