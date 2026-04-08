/**
 * Admin CD Account Management Routes
 * Lists all CD (codeid=3) accounts with payment progress and summary stats.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

const PACKAGE_MAP = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

/**
 * GET /api/admin/cd-accounts?page=1&search=username&status=all|paid|unpaid
 * List all CD accounts with pagination and summary stats
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 50;
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const status = req.query.status || 'all'; // all | paid | unpaid

    // Base WHERE clause: CD accounts only (codeid=3), main accounts
    let whereClause = 'WHERE u.codeid = 3 AND m.uid = u.uid AND u.uid = u.mainid';
    const params = [];

    // Status filter
    if (status === 'paid') {
      whereClause += ' AND u.cdstatus = 2';
    } else if (status === 'unpaid') {
      whereClause += ' AND u.cdstatus = 1';
    }

    // Search filter
    if (search) {
      const searchPattern = `%${search}%`;
      whereClause += ' AND (m.username LIKE ? OR m.firstname LIKE ? OR m.lastname LIKE ?)';
      params.push(searchPattern, searchPattern, searchPattern);
    }

    // Summary stats query (across all matching records, not paginated)
    const summaryQuery = `
      SELECT
        COUNT(*) AS totalCd,
        SUM(CASE WHEN u.cdstatus = 2 THEN 1 ELSE 0 END) AS fullyPaid,
        SUM(CASE WHEN u.cdstatus = 1 THEN 1 ELSE 0 END) AS stillPaying,
        COALESCE(SUM(u.cdamount), 0) AS totalCdAmount,
        COALESCE(SUM(u.cdamount - u.cdtotal), 0) AS totalRemaining,
        COALESCE(SUM(u.cdtotal), 0) AS totalPaid
      FROM usertab u, memberstab m
      ${whereClause}
    `;

    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM usertab u, memberstab m
      ${whereClause}
    `;

    // List query
    const listQuery = `
      SELECT
        m.uid, m.username, m.firstname, m.lastname,
        u.currentaccttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
        DATE_FORMAT(u.datereg, '%Y-%m-%d') AS regdate
      FROM usertab u, memberstab m
      ${whereClause}
      ORDER BY u.datereg DESC
      LIMIT ?, ?
    `;

    // Run all three queries in parallel
    const [summaryRows, countRows, listRows] = await Promise.all([
      pool.query(summaryQuery, params),
      pool.query(countQuery, params),
      pool.query(listQuery, [...params, offset, perPage]),
    ]);

    const summary = summaryRows[0][0];
    const total = Number(countRows[0][0].total);

    const accounts = listRows[0].map((r) => {
      const remaining = r.cdamount - r.cdtotal;
      const progress = r.cdamount > 0
        ? Math.min(100, Math.round((r.cdtotal / r.cdamount) * 100))
        : 0;
      const fullname = `${r.firstname || ''} ${r.lastname || ''}`.trim();

      return {
        uid: r.uid,
        username: r.username,
        firstname: r.firstname,
        lastname: r.lastname,
        fullname,
        package: PACKAGE_MAP[r.currentaccttype] || `Type ${r.currentaccttype}`,
        accttype: r.currentaccttype,
        currentaccttype: r.currentaccttype,
        codeid: r.codeid,
        cdstatus: r.cdstatus,
        cdstatusLabel: r.cdstatus === 2 ? 'Fully Paid' : 'Unpaid',
        cdamount: r.cdamount,
        cdtotal: r.cdtotal,
        remaining,
        progress,
        datereg: r.regdate,
        regdate: r.regdate,
      };
    });

    const stats = {
      total: Number(summary.totalCd) || 0,
      fullyPaid: Number(summary.fullyPaid) || 0,
      stillPaying: Number(summary.stillPaying) || 0,
      totalCdAmount: Number(summary.totalCdAmount) || 0,
      totalRemaining: Number(summary.totalRemaining) || 0,
      totalPaid: Number(summary.totalPaid) || 0,
    };

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    res.json({
      success: true,
      accounts,
      stats,
      page,
      perPage,
      total,
      totalPages,
      data: {
        accounts,
        summary: stats,
        pagination: {
          page,
          perPage,
          total,
          totalPages,
        },
      },
    });
  } catch (err) {
    console.error('[Admin CD Accounts] List error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch CD accounts' });
  }
});

module.exports = router;
