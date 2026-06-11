/**
 * Admin Encashment Management Routes
 * 1:1 port of PHP adminpanel/accounts-encashment.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  buildEncashmentSummary,
  buildEncashmentExportRows,
} = require('../../services/adminReporting');
const {
  buildSectionedCsv,
  sendCsv,
} = require('../../services/csvExport');
const { resolvePayoutOption: resolveSinglePayoutOption } = require('../../services/payoutOptions');

const PACKAGE_LABELS = {
  10: 'Bronze',
  20: 'Silver',
  30: 'Gold',
  40: 'Platinum',
  50: 'Garnet',
  60: 'Diamond',
};

function buildEncashmentWhereClause({ startDate = '', endDate = '', q = '' }) {
  let whereSql = `WHERE (p.transactiontype = 10 OR p.encashment1 > 0)`;
  const whereParams = [];
  const searchLike = `%${q}%`;

  if (startDate) {
    whereSql += ` AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') >= ?`;
    whereParams.push(startDate);
  }

  if (endDate) {
    whereSql += ` AND DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') <= ?`;
    whereParams.push(endDate);
  }

  if (q) {
    whereSql += `
      AND (
        m.username LIKE ?
        OR m.firstname LIKE ?
        OR m.lastname LIKE ?
        OR CONCAT(m.firstname, ' ', m.lastname) LIKE ?
      )
    `;
    whereParams.push(searchLike, searchLike, searchLike, searchLike);
  }

  return { whereSql, whereParams };
}

function normalizePayoutOption(rawValue) {
  return resolveSinglePayoutOption(rawValue, { allowUnknown: true });
}

function resolvePreferredPayoutOption(historyOption, profileOption) {
  return normalizePayoutOption(historyOption) || normalizePayoutOption(profileOption);
}

function buildPayoutDisplay(optionLabel, rawDetails) {
  const option = String(optionLabel || '').trim();
  const details = String(rawDetails || '').trim();

  if (option && details) {
    if (details.toLowerCase().startsWith(option.toLowerCase())) {
      return details;
    }
    return `${option} / ${details}`;
  }

  if (option) return option;
  if (details) return details;
  return 'N/A';
}

function mapEncashmentRow(r) {
  const tax = Number(r.tax_1 || 0);
  const fee = Number(r.encashmentfee || 0);
  const cdDeduction = Number(r.cddeduction || 0);
  const fullName = `${r.firstname || ''} ${r.lastname || ''}`.trim() || `Unknown Account (UID: ${r.uid})`;
  const payout = resolvePreferredPayoutOption(r.paymentoptions, r.payoutid);
  const payoutOption = payout?.label || 'N/A';
  const payoutRaw = String(r.paymentdetails || r.payoutdetails || '').trim();
  const payoutDetails = buildPayoutDisplay(payout?.label, payoutRaw);

  return {
    pid: Number(r.pid),
    uid: Number(r.uid),
    username: r.username || 'N/A',
    fullname: fullName,
    encashment: Number(r.encashment1 || 0),
    tax,
    fee,
    cdDeduction,
    deductions: tax + fee + cdDeduction,
    cashStatus: Number(r.cashstatus || 0),
    cashStatusLabel: Number(r.cashstatus || 0) === 1 ? 'Paid' : 'Pending',
    payoutId: payout?.id || null,
    payoutOption,
    payoutDetails,
    cashtransdate: r.cashtransdate,
    canViewCdDetails: cdDeduction > 0,
  };
}

async function fetchEncashmentRows({ whereSql, whereParams, offset = null, limit = null }) {
  const paginationSql = Number.isFinite(offset) && Number.isFinite(limit) ? 'LIMIT ?, ?' : '';
  const params = Number.isFinite(offset) && Number.isFinite(limit)
    ? [...whereParams, offset, limit]
    : whereParams;

  const [rows] = await pool.query(
    `SELECT p.pid, p.uid, DATE_FORMAT(p.cashtransdate, '%Y-%m-%d') as cashtransdate,
            p.cashstatus, p.cddeduction, p.encashment1, p.tax_1, p.encashmentfee,
            p.paymentoptions, p.paymentdetails,
            m.payoutid, m.payoutdetails, m.username, m.firstname, m.lastname
     FROM payouthistorytab p
     LEFT JOIN memberstab m ON m.uid = p.uid
     ${whereSql}
     ORDER BY p.cashtransdate DESC, p.pid DESC
     ${paginationSql}`,
    params
  );

  return rows.map(mapEncashmentRow);
}

/**
 * GET /api/admin/encashment?page=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&q=keyword
 * List encashment records with optional filters
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 50;
    const offset = (page - 1) * perPage;

    const startDate = (req.query.startDate || '').trim();
    const endDate = (req.query.endDate || '').trim();
    const q = (req.query.q || '').trim();
    const { whereSql, whereParams } = buildEncashmentWhereClause({ startDate, endDate, q });

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM payouthistorytab p
       LEFT JOIN memberstab m ON m.uid = p.uid
       ${whereSql}`,
      whereParams
    );
    const total = Number(countRows[0].total);
    const [records, summaryRecords] = await Promise.all([
      fetchEncashmentRows({ whereSql, whereParams, offset, limit: perPage }),
      fetchEncashmentRows({ whereSql, whereParams }),
    ]);

    res.json({
      records,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
      summary: buildEncashmentSummary(summaryRecords),
    });
  } catch (err) {
    console.error('[Admin Encashment] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/export', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const startDate = (req.query.startDate || '').trim();
    const endDate = (req.query.endDate || '').trim();
    const q = (req.query.q || '').trim();
    const { whereSql, whereParams } = buildEncashmentWhereClause({ startDate, endDate, q });
    const records = await fetchEncashmentRows({ whereSql, whereParams });
    const summary = buildEncashmentSummary(records);
    const csv = buildSectionedCsv([
      {
        title: 'Summary',
        rows: [
          { Metric: 'Search', Value: q || 'All records' },
          { Metric: 'Start Date', Value: startDate || 'All dates' },
          { Metric: 'End Date', Value: endDate || 'Latest' },
          { Metric: 'Total Records', Value: summary.overview.totalRecords },
          { Metric: 'Gross Encashment', Value: summary.overview.grossEncashment },
          { Metric: 'Net Receivable', Value: summary.overview.netReceivable },
          { Metric: 'Total Deductions', Value: summary.overview.totalDeductions },
          { Metric: 'CD Deduction', Value: summary.overview.totalCdDeduction },
        ],
      },
      {
        title: 'Encashments',
        rows: buildEncashmentExportRows(records),
      },
      {
        title: 'Daily Summary',
        rows: summary.daily.map((row) => ({
          Date: row.date,
          'Total Records': row.totalRecords,
          'Unique Members': row.uniqueMembers,
          'Gross Encashment': row.grossEncashment,
          'Net Receivable': row.netReceivable,
          Tax: row.totalTax,
          Fee: row.totalFee,
          'CD Deduction': row.totalCdDeduction,
          'Total Deductions': row.totalDeductions,
          Paid: row.paidCount,
          Pending: row.pendingCount,
        })),
      },
    ]);
    sendCsv(res, `encashment-report-${startDate || 'all'}-${endDate || 'latest'}`, csv);
  } catch (err) {
    console.error('[Admin Encashment] Export error:', err);
    res.status(500).json({ error: 'Failed to export encashment report' });
  }
});

/**
 * GET /api/admin/encashment/:pid/details?uid=123
 * Full encashment breakdown for modal/receipt preview.
 */
router.get('/:pid/details', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const uidFilter = req.query.uid ? Number(req.query.uid) : null;

    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Invalid encashment reference' });
    }

    const whereUidSql = Number.isFinite(uidFilter) ? 'AND p.uid = ?' : '';
    const params = Number.isFinite(uidFilter) ? [pid, uidFilter] : [pid];

    const [rows] = await pool.query(
      `SELECT p.pid, p.uid,
              DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
              DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
              p.transactiontype, p.cashstatus,
              p.beginningbalance, p.endingbalance,
              p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
              p.encashment1, p.tax_1, p.encashmentfee, p.cddeduction,
              p.paymentoptions, p.paymentdetails,
              m.username, m.firstname, m.lastname, m.payoutid, m.payoutdetails,
              u.currentaccttype
       FROM payouthistorytab p
       LEFT JOIN memberstab m ON m.uid = p.uid
       LEFT JOIN usertab u ON u.uid = p.uid
       WHERE p.pid = ? ${whereUidSql}
       LIMIT 1`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Encashment record not found' });
    }

    const row = rows[0];
    const tax = Number(row.tax_1 || 0);
    const fee = Number(row.encashmentfee || 0);
    const cdDeduction = Number(row.cddeduction || 0);
    const deductions = tax + fee + cdDeduction;
    const netReceivable = Number(row.encashment1 || 0);
    const grossEncashment = Number(row.transactiontype || 0) === 10
      ? netReceivable + deductions
      : 0;

    const income = {
      directReferral: Number(row.income1 || 0),
      pairing: Number(row.income2 || 0),
      leadership: Number(row.income3 || 0),
      unilevel: Number(row.income4 || 0),
      hifive: Number(row.income5 || 0),
      rankingBonus: Number(row.income6 || 0),
    };

    const payout = resolvePreferredPayoutOption(row.paymentoptions, row.payoutid);
    const paymentOption = payout?.label || 'N/A';
    const paymentDetails = String(row.paymentdetails || row.payoutdetails || '').trim() || null;

    res.json({
      pid: Number(row.pid),
      uid: Number(row.uid),
      username: row.username || 'N/A',
      fullname: `${row.firstname || ''} ${row.lastname || ''}`.trim() || `UID ${row.uid}`,
      packageType: PACKAGE_LABELS[Number(row.currentaccttype || 0)] || 'Unknown',
      transactionType: Number(row.transactiontype || 0),
      transactionTypeName:
        Number(row.transactiontype || 0) === 10
          ? 'Encashment'
          : Number(row.transactiontype || 0) === 1
            ? 'Income'
            : 'Other',
      status: Number(row.cashstatus || 0),
      statusLabel: Number(row.cashstatus || 0) === 1 ? 'Paid' : 'Pending',
      transdate: row.transdate,
      cashtransdate: row.cashtransdate,
      beginningBalance: Number(row.beginningbalance || 0),
      endingBalance: Number(row.endingbalance || 0),
      income,
      grossEncashment,
      netReceivable,
      deductions: {
        tax,
        fee,
        cdDeduction,
        total: deductions,
      },
      paymentOption,
      paymentOptionId: payout?.id || null,
      paymentDetails,
      canViewCdDetails: cdDeduction > 0,
    });
  } catch (err) {
    console.error('[Admin Encashment] Details error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/encashment/:pid/process
 * Mark encashment as processed
 */
router.put('/:pid/process', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const { uid } = req.body;
    const numericUid = Number(uid);

    if (!Number.isFinite(pid) || !Number.isFinite(numericUid)) {
      return res.status(400).json({ error: 'Invalid encashment reference' });
    }

    const [ownerRows] = await pool.query(
      'SELECT uid FROM payouthistorytab WHERE pid = ? LIMIT 1',
      [pid]
    );

    if (ownerRows.length === 0) {
      return res.status(404).json({ error: 'Encashment record not found' });
    }

    if (Number(ownerRows[0].uid) !== numericUid) {
      return res.status(409).json({ error: 'Encashment record does not belong to the supplied member.' });
    }

    const [result] = await pool.query(
      "UPDATE payouthistorytab SET cashstatus = 1, cashtransdate = NOW() WHERE pid = ? AND uid = ? LIMIT 1",
      [pid, numericUid]
    );

    if (result.affectedRows === 1) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Update failed' });
    }
  } catch (err) {
    console.error('[Admin Encashment] Process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.__private = {
  normalizePayoutOption,
  buildPayoutDisplay,
  mapEncashmentRow,
};
