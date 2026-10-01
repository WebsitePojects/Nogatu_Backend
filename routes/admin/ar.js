/**
 * AR (Acknowledgement Receipt) admin API.
 * Rights: 1 = Super Admin, 2 = Cashier, 3 = BOD (read + reports only).
 * readonlyGuard is mounted on /api/admin in index.js, so read-only accounts can never write here.
 */
const express = require('express');
const ExcelJS = require('exceljs');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { idempotent } = require('../../middleware/idempotency');
const receipts = require('../../services/ar/arReceipts');
const settings = require('../../services/ar/arSettings');
const queries = require('../../services/ar/arQueries');
const { MODES, STOCKIST_TYPES, PAYMENT_METHODS } = require('../../services/ar/arPricing');

const router = express.Router();
const SUPER = [1];
const SELLERS = [1, 2];
const READERS = [1, 2, 3];
const REPORTERS = [1, 3];

const STATUS_BY_CODE = {
  AR_FORBIDDEN: 403,
  AR_NOT_FOUND: 404,
  AR_WRONG_STATUS: 409,
  AR_ALREADY_RELEASED: 409,
  AR_DUPLICATE_NUMBER: 409,
  AR_SEQUENCE_LOCKED: 409,
  AR_RELEASE_CONFLICT: 409,
  AR_BUSY: 503,
};

function adminOf(req) {
  return {
    id: Number(req.session.adminNumericId || 0),
    username: String(req.session.adminid || ''),
    rights: Number(req.session.adminrights || 0),
  };
}

/** Wraps a handler: known AR errors become readable 4xx responses; anything else is a logged 500. */
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    const code = String(error.code || '');
    const known = code.startsWith('AR_') || code === 'INVALID_CODE_GENERATION_REQUEST';
    if (known) return res.status(STATUS_BY_CODE[code] || 400).json({ error: error.message, code });
    console.error('[Admin AR]', req.method, req.originalUrl, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Reference data ──────────────────────────────────────────────────────────
router.get('/meta', adminAuth, adminRights(READERS), handle(async () => ({
  modes: Object.entries(MODES).map(([key, m]) => ({ key, label: m.label, kind: m.kind, generatesCodes: m.generatesCodes, requiresMember: m.requiresMember, requiresStockist: Boolean(m.requiresStockist) })),
  stockistTypes: Object.entries(STOCKIST_TYPES).map(([value, label]) => ({ value: Number(value), label })),
  paymentMethods: PAYMENT_METHODS,
})));
router.get('/centers', adminAuth, adminRights(READERS), handle(() => settings.listCenters()));
router.get('/prices', adminAuth, adminRights(READERS), handle(() => settings.listPrices()));
router.get('/discounts', adminAuth, adminRights(READERS), handle(() => settings.listDiscounts()));
router.get('/stockists', adminAuth, adminRights(READERS), handle(() => settings.listStockists()));

/** Cashier lookup while building an AR: who is this member, and are they a stockist? */
router.get('/member/:username', adminAuth, adminRights(SELLERS), handle((req) => settings.lookupMember(req.params.username)));

// ── Super Admin settings ────────────────────────────────────────────────────
router.get('/sequence', adminAuth, adminRights(SUPER), handle(() => settings.sequenceStatus()));
router.post('/sequence', adminAuth, adminRights(SUPER), idempotent('admin.ar.sequence'),
  handle((req) => receipts.seedSequence(req.session, req.body?.latestPaperNumber)));
router.put('/prices', adminAuth, adminRights(SUPER), handle((req) => settings.upsertPrice(adminOf(req), req.body)));
router.put('/discounts', adminAuth, adminRights(SUPER), handle((req) => settings.setDiscount(adminOf(req), req.body)));
router.put('/stockists', adminAuth, adminRights(SUPER), handle((req) => settings.setStockist(adminOf(req), req.body)));
router.get('/cashiers', adminAuth, adminRights(SUPER), handle(() => settings.listCashiers()));
router.put('/cashiers', adminAuth, adminRights(SUPER), handle((req) => settings.assignCashierCenter(adminOf(req), req.body)));

// ── Receipts ────────────────────────────────────────────────────────────────
router.get('/receipts', adminAuth, adminRights(READERS), handle((req) => queries.listReceipts(adminOf(req), req.query)));
router.get('/receipts/:id', adminAuth, adminRights(READERS), handle((req) => queries.getReceipt(adminOf(req), req.params.id)));
router.post('/receipts', adminAuth, adminRights(SELLERS), idempotent('admin.ar.create'),
  handle((req) => receipts.createReceipt(req.session, req.body, req.get('Idempotency-Key'))));
router.post('/receipts/:id/approve', adminAuth, adminRights(SUPER), idempotent('admin.ar.approve'),
  handle((req) => receipts.approveReceipt(req.session, req.params.id)));
router.post('/receipts/:id/void', adminAuth, adminRights(SELLERS), idempotent('admin.ar.void'),
  handle((req) => receipts.voidReceipt(req.session, req.params.id, req.body?.reason)));
router.post('/receipts/:id/print', adminAuth, adminRights(SELLERS),
  handle((req) => queries.recordPrint(adminOf(req), req.params.id)));
router.post('/legacy', adminAuth, adminRights(SUPER), idempotent('admin.ar.legacy'),
  handle((req) => receipts.createLegacyReceipt(req.session, req.body)));

// ── Reports ─────────────────────────────────────────────────────────────────
router.get('/reports/consolidation', adminAuth, adminRights(REPORTERS),
  handle((req) => queries.consolidation(adminOf(req), req.query)));

router.get('/reports/consolidation/export', adminAuth, adminRights(REPORTERS), async (req, res) => {
  try {
    const report = await queries.consolidation(adminOf(req), req.query);
    const wb = new ExcelJS.Workbook();
    const sheet = (name, columns, rows) => {
      const ws = wb.addWorksheet(name);
      ws.columns = columns;
      rows.forEach((r) => ws.addRow(r));
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      return ws;
    };
    const money = { numFmt: '#,##0.00' };
    sheet('By leader', [
      { header: 'Tree', key: 'tree', width: 12 }, { header: 'Leader', key: 'leader', width: 28 },
      { header: 'ARs', key: 'receipts', width: 8 }, { header: 'Total (PHP)', key: 'total', width: 16, style: money },
    ], report.byLeader);
    sheet('By buyer', [
      { header: 'Buyer', key: 'buyer_name', width: 30 }, { header: 'Sponsor leader', key: 'sponsor_leader', width: 26 },
      { header: 'Binary leader', key: 'binary_leader', width: 26 }, { header: 'ARs', key: 'receipts', width: 8 },
      { header: 'Discounts (PHP)', key: 'discounts', width: 16, style: money }, { header: 'Total (PHP)', key: 'total', width: 16, style: money },
    ], report.byBuyer);
    sheet('By center', [
      { header: 'Center', key: 'center', width: 18 }, { header: 'ARs', key: 'receipts', width: 8 },
      { header: 'Discounts (PHP)', key: 'discounts', width: 16, style: money }, { header: 'Total (PHP)', key: 'total', width: 16, style: money },
    ], report.byCenter);
    sheet('By cashier', [
      { header: 'Cashier', key: 'cashier', width: 20 }, { header: 'ARs', key: 'receipts', width: 8 },
      { header: 'Total (PHP)', key: 'total', width: 16, style: money },
    ], report.byCashier);
    sheet('By mode', [
      { header: 'Mode', key: 'mode', width: 16 }, { header: 'ARs', key: 'receipts', width: 8 },
      { header: 'Total (PHP)', key: 'total', width: 16, style: money },
    ], report.byMode);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="AR-consolidation-${report.from}-to-${report.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    const known = String(error.code || '').startsWith('AR_');
    if (known) return res.status(400).json({ error: error.message, code: error.code });
    console.error('[Admin AR] export', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
