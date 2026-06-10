/**
 * Admin View-As Routes
 * Allows admin (including readonly) accounts to browse any member's data
 * without modifying anything. All routes are GET-only.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth } = require('../../middleware/auth');
const { calculateAndStoreIncome } = require('../../services/income/calculateAndStoreIncome');
const { getProjectedCurrentMonthUnilevel, checkLastMaintenance } = require('../../services/income/unilevel');
const { getMemberGlobalBonus } = require('../../services/globalBonus');
const { getAccountTypeName } = require('../../utils/helpers');
const { getEffectiveAccountState } = require('../../services/accountState');

// All view-as routes require a valid admin session.
router.use(adminAuth);

/**
 * GET /api/admin/view-as/search?q=<username>
 * Search members by username (partial match). Returns up to 20 results.
 */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.json({ members: [] });
    }
    const [rows] = await pool.query(
      `SELECT m.uid, m.username,
              CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,'')) AS fullname,
              u.accttype, u.codeid, u.cdstatus, u.activedate
         FROM memberstab m
         JOIN usertab u ON u.uid = m.uid
        WHERE m.username LIKE ?
        ORDER BY m.username
        LIMIT 20`,
      [`%${q}%`]
    );
    res.json({
      members: rows.map((r) => ({
        uid: r.uid,
        username: r.username,
        fullname: String(r.fullname || '').trim(),
        accttype: r.accttype,
        acctTypeName: getAccountTypeName(r.accttype),
        codeid: r.codeid,
        cdstatus: r.cdstatus,
        activedate: r.activedate,
      })),
    });
  } catch (err) {
    console.error('[ViewAs] search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/profile
 * Member profile/account info (mirrors account details page).
 */
router.get('/:uid/profile', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const [rows] = await pool.query(
      `SELECT m.uid, m.username, m.fullname, m.email, m.mobileno, m.tin,
              m.address, m.birthdate, m.gender,
              u.accttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
              u.activedate, u.position, u.refid, u.drefid, u.binarypoints,
              u.account_status, u.account_status_reason
         FROM memberstab m
         JOIN usertab u ON u.uid = m.uid
        WHERE m.uid = ?
        LIMIT 1`,
      [uid]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const r = rows[0];
    const effective = await getEffectiveAccountState(r);

    // Fetch binary parent info
    let binaryParent = null;
    if (r.refid) {
      const [pRows] = await pool.query(
        'SELECT uid, username, fullname FROM memberstab WHERE uid = ? LIMIT 1',
        [r.refid]
      );
      if (pRows.length) binaryParent = { uid: pRows[0].uid, username: pRows[0].username, fullname: pRows[0].fullname };
    }

    // Fetch sponsor info
    let sponsor = null;
    if (r.drefid) {
      const [sRows] = await pool.query(
        'SELECT uid, username, fullname FROM memberstab WHERE uid = ? LIMIT 1',
        [r.drefid]
      );
      if (sRows.length) sponsor = { uid: sRows[0].uid, username: sRows[0].username, fullname: sRows[0].fullname };
    }

    res.json({
      uid: r.uid,
      username: r.username,
      fullname: r.fullname,
      email: r.email,
      mobileno: r.mobileno,
      tin: r.tin,
      address: r.address,
      birthdate: r.birthdate,
      gender: r.gender,
      accttype: r.accttype,
      acctTypeName: getAccountTypeName(r.accttype),
      codeid: r.codeid,
      cdstatus: r.cdstatus,
      cdamount: r.cdamount,
      cdtotal: r.cdtotal,
      activedate: r.activedate,
      position: r.position,
      binarypoints: r.binarypoints,
      accountStatus: r.account_status,
      accountStatusReason: r.account_status_reason,
      effectiveState: effective,
      binaryParent,
      sponsor,
    });
  } catch (err) {
    console.error('[ViewAs] profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/dashboard
 * Member dashboard data (income summary, binary points, etc.).
 */
router.get('/:uid/dashboard', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const [memberRows] = await pool.query(
      `SELECT m.uid, m.username, m.fullname, u.accttype, u.codeid, u.cdstatus
         FROM memberstab m JOIN usertab u ON u.uid = m.uid
        WHERE m.uid = ? LIMIT 1`,
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const member = memberRows[0];
    const updated = await calculateAndStoreIncome(uid, member.accttype);

    // Binary points
    const [pairRows] = await pool.query(
      `SELECT totalpointsleft, totalpointsright
         FROM pairingstab WHERE uid = ? LIMIT 1`,
      [uid]
    );
    const leftPoints = pairRows.length ? Number(pairRows[0].totalpointsleft || 0) / 250 : 0;
    const rightPoints = pairRows.length ? Number(pairRows[0].totalpointsright || 0) / 250 : 0;

    // Direct referral count
    const [drRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM usertab WHERE drefid = ?',
      [uid]
    );

    res.json({
      uid: member.uid,
      username: member.username,
      fullname: member.fullname,
      accttype: member.accttype,
      acctTypeName: getAccountTypeName(member.accttype),
      codeid: member.codeid,
      cdstatus: member.cdstatus,
      income: updated,
      binaryPoints: { left: leftPoints, right: rightPoints },
      directReferrals: drRows[0].total,
    });
  } catch (err) {
    console.error('[ViewAs] dashboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/wallet
 * Member e-wallet / income breakdown.
 */
router.get('/:uid/wallet', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const [memberRows] = await pool.query(
      `SELECT m.uid, m.username, u.accttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal
         FROM memberstab m JOIN usertab u ON u.uid = m.uid
        WHERE m.uid = ? LIMIT 1`,
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const member = memberRows[0];
    const [updated, maintenanceMet, projectedUnilevel, globalBonus] = await Promise.all([
      calculateAndStoreIncome(uid, member.accttype),
      checkLastMaintenance(uid),
      getProjectedCurrentMonthUnilevel(uid),
      getMemberGlobalBonus(uid).catch(() => ({ hasGlobalBonus: false, globalBonusAmount: 0 })),
    ]);

    res.json({
      uid: member.uid,
      username: member.username,
      accttype: member.accttype,
      acctTypeName: getAccountTypeName(member.accttype),
      codeid: member.codeid,
      cdstatus: member.cdstatus,
      cdamount: member.cdamount,
      cdtotal: member.cdtotal,
      income: updated,
      globalBonus,
      unilevelMaintenance: {
        maintenanceMet,
        projectedUnilevel,
      },
    });
  } catch (err) {
    console.error('[ViewAs] wallet error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/genealogy?type=binary|unilevel
 * Member genealogy tree (binary or unilevel).
 */
router.get('/:uid/genealogy', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const type = String(req.query.type || 'binary');

    const [memberRows] = await pool.query(
      'SELECT uid, username, fullname FROM memberstab WHERE uid = ? LIMIT 1',
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    if (type === 'unilevel') {
      // Fetch up to 3 levels of unilevel (drefid-based) tree
      const [rows] = await pool.query(
        `SELECT m.uid, m.username, m.fullname,
                u.accttype, u.codeid, u.cdstatus, u.drefid, u.activedate,
                1 AS level
           FROM usertab u
           JOIN memberstab m ON m.uid = u.uid
          WHERE u.drefid = ?
          UNION ALL
         SELECT m.uid, m.username, m.fullname,
                u.accttype, u.codeid, u.cdstatus, u.drefid, u.activedate,
                2 AS level
           FROM usertab u
           JOIN memberstab m ON m.uid = u.uid
          WHERE u.drefid IN (SELECT uid FROM usertab WHERE drefid = ?)
          UNION ALL
         SELECT m.uid, m.username, m.fullname,
                u.accttype, u.codeid, u.cdstatus, u.drefid, u.activedate,
                3 AS level
           FROM usertab u
           JOIN memberstab m ON m.uid = u.uid
          WHERE u.drefid IN (
            SELECT uid FROM usertab
            WHERE drefid IN (SELECT uid FROM usertab WHERE drefid = ?)
          )
         ORDER BY level, username`,
        [uid, uid, uid]
      );
      return res.json({
        uid,
        type: 'unilevel',
        members: rows.map((r) => ({
          uid: r.uid,
          username: r.username,
          fullname: r.fullname,
          accttype: r.accttype,
          acctTypeName: getAccountTypeName(r.accttype),
          codeid: r.codeid,
          cdstatus: r.cdstatus,
          sponsorUid: r.drefid,
          activedate: r.activedate,
          level: r.level,
        })),
      });
    }

    // Binary tree — 3 levels deep
    const [rows] = await pool.query(
      `SELECT m.uid, m.username, m.fullname,
              u.accttype, u.codeid, u.cdstatus, u.refid, u.position, u.binarypoints, u.activedate,
              1 AS level
         FROM usertab u
         JOIN memberstab m ON m.uid = u.uid
        WHERE u.refid = ?
        UNION ALL
       SELECT m.uid, m.username, m.fullname,
              u.accttype, u.codeid, u.cdstatus, u.refid, u.position, u.binarypoints, u.activedate,
              2 AS level
         FROM usertab u
         JOIN memberstab m ON m.uid = u.uid
        WHERE u.refid IN (SELECT uid FROM usertab WHERE refid = ?)
        UNION ALL
       SELECT m.uid, m.username, m.fullname,
              u.accttype, u.codeid, u.cdstatus, u.refid, u.position, u.binarypoints, u.activedate,
              3 AS level
         FROM usertab u
         JOIN memberstab m ON m.uid = u.uid
        WHERE u.refid IN (
          SELECT uid FROM usertab WHERE refid IN (SELECT uid FROM usertab WHERE refid = ?)
        )
       ORDER BY level, position, username`,
      [uid, uid, uid]
    );
    res.json({
      uid,
      type: 'binary',
      members: rows.map((r) => ({
        uid: r.uid,
        username: r.username,
        fullname: r.fullname,
        accttype: r.accttype,
        acctTypeName: getAccountTypeName(r.accttype),
        codeid: r.codeid,
        cdstatus: r.cdstatus,
        parentUid: r.refid,
        position: r.position,
        binaryPoints: Number(r.binarypoints || 0) / 250,
        activedate: r.activedate,
        level: r.level,
      })),
    });
  } catch (err) {
    console.error('[ViewAs] genealogy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/transactions?page=1&limit=20
 * Member transaction / payout history.
 */
router.get('/:uid/transactions', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [memberRows] = await pool.query(
      'SELECT uid, username FROM memberstab WHERE uid = ? LIMIT 1',
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const [[{ total }], rows] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM payouthistorytab WHERE uid = ?', [uid]),
      pool.query(
        `SELECT id, uid, incometype, amount, transdate, remarks, status
           FROM payouthistorytab
          WHERE uid = ?
          ORDER BY transdate DESC, id DESC
          LIMIT ? OFFSET ?`,
        [uid, limit, offset]
      ),
    ]);

    res.json({
      uid,
      username: memberRows[0].username,
      page,
      limit,
      total,
      transactions: rows[0],
    });
  } catch (err) {
    console.error('[ViewAs] transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/view-as/:uid/referrals
 * Direct referrals list for a member.
 */
router.get('/:uid/referrals', async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const [memberRows] = await pool.query(
      'SELECT uid, username FROM memberstab WHERE uid = ? LIMIT 1',
      [uid]
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const [rows] = await pool.query(
      `SELECT m.uid, m.username, m.fullname,
              u.accttype, u.codeid, u.cdstatus, u.activedate, u.position
         FROM usertab u
         JOIN memberstab m ON m.uid = u.uid
        WHERE u.drefid = ?
        ORDER BY u.activedate DESC, m.username`,
      [uid]
    );

    res.json({
      uid,
      username: memberRows[0].username,
      referrals: rows.map((r) => ({
        uid: r.uid,
        username: r.username,
        fullname: r.fullname,
        accttype: r.accttype,
        acctTypeName: getAccountTypeName(r.accttype),
        codeid: r.codeid,
        cdstatus: r.cdstatus,
        position: r.position,
        activedate: r.activedate,
      })),
    });
  } catch (err) {
    console.error('[ViewAs] referrals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
