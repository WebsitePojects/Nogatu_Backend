/**
 * Admin income-release report (management meeting 2026-11-10). READ-ONLY.
 * Month-by-month income released vs. codes encoded, JSON or Excel.
 */
const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  buildIncomeReleaseReport,
  buildIncomeReleaseWorkbook,
} = require('../../services/incomeReport');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

router.get('/income-release', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    const report = await buildIncomeReleaseReport({ from, to });

    if (String(req.query.format || '').toLowerCase() === 'xlsx') {
      // Build the whole file before sending a byte: a failure then returns a clean 500
      // instead of a truncated 200 download.
      const buffer = Buffer.from(await buildIncomeReleaseWorkbook(report).xlsx.writeBuffer());
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Nogatu_Income_Release_${report.range.from}_to_${report.range.to}.xlsx"`
      );
      return res.end(buffer);
    }
    return res.json({ success: true, data: report });
  } catch (err) {
    if (err && err.code === 'INVALID_RANGE') {
      return res.status(400).json({ success: false, error: err.message, code: 'INVALID_RANGE' });
    }
    console.error('[Admin Income Report] error:', err);
    return res.status(500).json({ success: false, error: 'Failed to build income report' });
  }
});

module.exports = router;
