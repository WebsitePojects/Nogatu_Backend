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

/**
 * GET /api/admin/reports/income-per-code?from=YYYY-MM&to=YYYY-MM[&code=XXXX][&format=xlsx]
 * Income triggered per activation code, recomputed by rule (services/incomePerCode.js). READ-ONLY.
 * JSON returns the per-package summary + reconciliation check, and the rows of one code when
 * `code` is given; the full per-code list is the Excel download.
 * The replay is CPU work on the single production worker (~0.5 s on the full tree), so only one
 * build runs at a time; a second request gets 429 instead of stacking.
 */
let perCodeInFlight = false;

router.get('/income-per-code', adminAuth, adminRights([1, 3]), async (req, res) => {
  const {
    resolveRange, loadSnapshot, computeIncomePerCode, buildIncomePerCodeWorkbook,
  } = require('../../services/incomePerCode');
  let range;
  try {
    range = resolveRange({ from: String(req.query.from ?? ''), to: String(req.query.to ?? '') });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, code: 'INVALID_RANGE' });
  }
  const codeFilter = String(req.query.code ?? '').trim().toUpperCase();
  if (codeFilter && !/^[A-Z0-9]{4,20}$/.test(codeFilter)) {
    return res.status(400).json({ success: false, error: 'Code must be 4-20 letters or digits.', code: 'INVALID_CODE' });
  }
  if (perCodeInFlight) {
    return res.status(429).json({ success: false, error: 'This report is already being built. Try again in a few seconds.', code: 'BUSY' });
  }

  perCodeInFlight = true;
  let conn = null;
  try {
    conn = await require('../../config/database').pool.getConnection();
    // One consistent snapshot of the three reads; MySQL rejects any write inside READ ONLY.
    await conn.query('START TRANSACTION READ ONLY');
    const snapshot = await loadSnapshot(conn);
    await conn.query('COMMIT');
    conn.release();
    conn = null;

    const report = await computeIncomePerCode(range, snapshot);
    if (String(req.query.format || '').toLowerCase() === 'xlsx') {
      const buffer = Buffer.from(await buildIncomePerCodeWorkbook(report).xlsx.writeBuffer());
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Nogatu_Income_Per_Code_${report.range.from}_to_${report.range.to}.xlsx"`
      );
      return res.end(buffer);
    }
    const codeRows = codeFilter
      ? report.rows.filter((row) => String(row.code).toUpperCase() === codeFilter).slice(0, 20)
      : [];
    return res.json({
      success: true,
      data: { range: report.range, summary: report.summary, check: report.check, codeRows, totalCodes: report.rows.length },
    });
  } catch (err) {
    console.error('[Admin Income Per Code] error:', err);
    return res.status(500).json({ success: false, error: 'Failed to build income per code report' });
  } finally {
    if (conn) {
      try { await conn.query('ROLLBACK'); } catch (_) { /* connection may already be closed */ }
      conn.release();
    }
    perCodeInFlight = false;
  }
});

module.exports = router;
