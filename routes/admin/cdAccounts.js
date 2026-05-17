const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { getAccountTypeName } = require('../../utils/helpers');

/**
 * GET /api/admin/cd-accounts?page=1&search=username&status=all|paid|unpaid
 * Paginated list of CD accounts for the admin dashboard.
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').trim().toLowerCase();

    const filters = ['u.codeid = 3'];
    const params = [];

    if (status === 'paid') {
      filters.push('(u.cdstatus = 2 OR COALESCE(u.cdtotal, 0) >= COALESCE(u.cdamount, 0))');
    } else if (status === 'unpaid') {
      filters.push('NOT (u.cdstatus = 2 OR COALESCE(u.cdtotal, 0) >= COALESCE(u.cdamount, 0))');
    }

    if (search) {
      filters.push('(m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT u.uid, u.accttype, u.currentaccttype, u.cdamount, u.cdtotal, u.cdstatus,
              DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg,
              m.username, m.firstname, m.lastname
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       ${whereSql}
       ORDER BY u.cdstatus ASC, u.datereg DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    const [statsRows] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN u.cdstatus = 2 OR COALESCE(u.cdtotal, 0) >= COALESCE(u.cdamount, 0) THEN 1 ELSE 0 END) AS fullyPaid,
              SUM(CASE WHEN NOT (u.cdstatus = 2 OR COALESCE(u.cdtotal, 0) >= COALESCE(u.cdamount, 0)) THEN 1 ELSE 0 END) AS stillPaying,
              COALESCE(SUM(u.cdamount), 0) AS totalCdAmount,
              COALESCE(SUM(u.cdtotal), 0) AS totalPaid
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
       ${whereSql}`,
      params
    );

    res.json({
      accounts: rows.map((row) => ({
        uid: Number(row.uid),
        username: row.username,
        fullname: `${row.firstname} ${row.lastname}`.trim(),
        accttype: Number(row.currentAccttype || row.currentaccttype || row.accttype || 0),
        accttypeName: getAccountTypeName(row.currentaccttype || row.accttype),
        cdamount: Number(row.cdamount || 0),
        cdtotal: Number(row.cdtotal || 0),
        cdstatus: Number(row.cdstatus || 0),
        datereg: row.datereg,
      })),
      stats: {
        total: Number(statsRows[0]?.total || 0),
        fullyPaid: Number(statsRows[0]?.fullyPaid || 0),
        stillPaying: Number(statsRows[0]?.stillPaying || 0),
        totalCdAmount: Number(statsRows[0]?.totalCdAmount || 0),
        totalPaid: Number(statsRows[0]?.totalPaid || 0),
      },
      page,
      perPage,
      status,
      totalPages: Math.max(1, Math.ceil(Number(countRows[0]?.total || 0) / perPage)),
      total: Number(countRows[0]?.total || 0),
    });
  } catch (error) {
    console.error('[Admin CD Accounts] List error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
