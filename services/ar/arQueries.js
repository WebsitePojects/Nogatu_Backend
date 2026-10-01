/**
 * Read side of the AR system: receipt list/detail and the consolidation report.
 * Raw activation codes are never returned; a receipt only reports how many codes it released.
 */
const { pool } = require('../../config/database');
const { findLeadersForMembers } = require('../leaders');
const { arError, isRealIsoDate } = require('./arPricing');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 200;
const STATUSES = ['pending_approval', 'completed', 'void'];
// Every report click walks each buyer's leader chain, so the range is bounded.
const MAX_REPORT_DAYS = 366;

/** Cashiers see only their own center; Super Admin and BOD see everything. */
async function centerScope(admin) {
  if (admin.rights !== 2) return null;
  const [[row]] = await pool.query('SELECT ar_center_id FROM accesstab WHERE id = ? LIMIT 1', [admin.id]);
  return Number(row?.ar_center_id || 0) || -1; // -1 matches nothing: an unbound cashier sees no ARs
}

function dateRange(query) {
  const from = isRealIsoDate(query.from) ? query.from : null;
  const to = isRealIsoDate(query.to) ? query.to : null;
  if (!from || !to) throw arError('Choose a from and to date (YYYY-MM-DD)');
  if (from > to) throw arError('The from date must be on or before the to date');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_REPORT_DAYS) throw arError(`A report can cover at most ${MAX_REPORT_DAYS} days`);
  return { from, to };
}

/** Business date of an AR: the paper date for legacy ARs, the creation date otherwise. */
const BUSINESS_DATE = 'COALESCE(r.legacy_date, DATE(r.created_at))';

async function listReceipts(admin, query = {}) {
  const where = ['1 = 1'];
  const params = [];
  const scope = await centerScope(admin);
  if (scope !== null) { where.push('r.center_id = ?'); params.push(scope); }
  if (query.status) {
    if (!STATUSES.includes(String(query.status))) throw arError('Unknown status filter');
    where.push('r.status = ?'); params.push(String(query.status));
  }
  if (query.centerId) {
    const centerId = Number(query.centerId);
    if (!Number.isInteger(centerId) || centerId < 1) throw arError('Unknown center filter');
    where.push('r.center_id = ?'); params.push(centerId);
  }
  if (query.from && ISO_DATE.test(query.from)) { where.push(`${BUSINESS_DATE} >= ?`); params.push(query.from); }
  if (query.to && ISO_DATE.test(query.to)) { where.push(`${BUSINESS_DATE} <= ?`); params.push(query.to); }
  if (query.search) {
    const term = `%${String(query.search).trim().slice(0, 60)}%`;
    where.push('(r.ar_no LIKE ? OR r.buyer_name LIKE ? OR m.username LIKE ?)');
    params.push(term, term, term);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), MAX_PAGE);
  const offset = Math.max(Number(query.offset) || 0, 0);

  const [rows] = await pool.query(
    `SELECT r.id, r.ar_no, r.mode, r.status, r.is_legacy, ${BUSINESS_DATE} AS business_date, r.created_at,
            r.buyer_name, m.username AS buyer_username, rm.username AS recipient_username,
            r.total, r.discount_total, r.payment_method, r.prepared_by, r.approved_by, r.release_error,
            c.name AS center_name
       FROM ar_receipttab r
       JOIN ar_centertab c ON c.id = r.center_id
       LEFT JOIN memberstab m ON m.uid = r.buyer_uid
       LEFT JOIN memberstab rm ON rm.uid = r.recipient_uid
      WHERE ${where.join(' AND ')}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[count]] = await pool.query(
    `SELECT COUNT(*) AS n FROM ar_receipttab r LEFT JOIN memberstab m ON m.uid = r.buyer_uid WHERE ${where.join(' AND ')}`,
    params
  );
  return { rows, total: Number(count.n), limit, offset };
}

async function getReceipt(admin, arId) {
  const scope = await centerScope(admin);
  const [[receipt]] = await pool.query(
    `SELECT r.*, c.name AS center_name, c.address AS center_address, c.contact_number AS center_contact,
            m.username AS buyer_username, rm.username AS recipient_username
       FROM ar_receipttab r
       JOIN ar_centertab c ON c.id = r.center_id
       LEFT JOIN memberstab m ON m.uid = r.buyer_uid
       LEFT JOIN memberstab rm ON rm.uid = r.recipient_uid
      WHERE r.id = ? LIMIT 1`,
    [Number(arId)]
  );
  if (!receipt || (scope !== null && receipt.center_id !== scope)) throw arError('AR not found', 'AR_NOT_FOUND');
  const [items] = await pool.query('SELECT * FROM ar_itemtab WHERE ar_id = ? ORDER BY id', [receipt.id]);
  const [[codes]] = await pool.query('SELECT COUNT(*) AS n FROM ar_code_linktab WHERE ar_id = ?', [receipt.id]);
  return { ...receipt, items, codes_released: Number(codes.n) };
}

async function recordPrint(admin, arId) {
  // Scope check first: a cashier must not bump the counter on another center's AR.
  const receipt = await getReceipt(admin, arId);
  await pool.query('UPDATE ar_receipttab SET print_count = print_count + 1 WHERE id = ?', [receipt.id]);
  return getReceipt(admin, receipt.id);
}

/**
 * Consolidation report for a date range: totals by center, cashier and mode, per buyer, and per
 * leader with the sponsor and binary leader side by side. Void ARs are excluded; legacy ARs count
 * on their paper date.
 */
async function consolidation(admin, query = {}) {
  const { from, to } = dateRange(query);
  const scope = await centerScope(admin);
  const where = [`r.status = 'completed'`, `${BUSINESS_DATE} BETWEEN ? AND ?`];
  const params = [from, to];
  if (scope !== null) { where.push('r.center_id = ?'); params.push(scope); }
  const w = where.join(' AND ');

  const group = async (select, by) => {
    const [rows] = await pool.query(
      `SELECT ${select}, COUNT(*) AS receipts, SUM(r.total) AS total, SUM(r.discount_total) AS discounts
         FROM ar_receipttab r JOIN ar_centertab c ON c.id = r.center_id
        WHERE ${w} GROUP BY ${by} ORDER BY total DESC`,
      params
    );
    return rows;
  };

  const [byCenter, byCashier, byMode, byBuyer] = await Promise.all([
    group('c.name AS center', 'c.name'),
    group('r.prepared_by AS cashier', 'r.prepared_by'),
    group('r.mode', 'r.mode'),
    // A member is one buyer however their name was typed; walk-ins group by the name on the receipt.
    group('r.buyer_uid, MAX(r.buyer_name) AS buyer_name', 'r.buyer_uid, CASE WHEN r.buyer_uid IS NULL THEN r.buyer_name END'),
  ]);

  // One batched chain walk per tree for every buyer, not two queries per buyer.
  const leaders = await findLeadersForMembers(byBuyer.map((row) => row.buyer_uid).filter(Boolean));
  const byLeader = new Map();
  for (const row of byBuyer) {
    if (!row.buyer_uid) continue;
    const { unilevel, binary } = leaders.get(Number(row.buyer_uid)) || { unilevel: null, binary: null };
    row.sponsor_leader = unilevel?.name || null;
    row.binary_leader = binary?.name || null;
    for (const [tree, leader] of [['sponsor', unilevel], ['binary', binary]]) {
      const key = `${tree}:${leader?.name || 'No leader'}`;
      const agg = byLeader.get(key) || { tree, leader: leader?.name || 'No leader', receipts: 0, total: 0 };
      agg.receipts += Number(row.receipts);
      agg.total += Number(row.total);
      byLeader.set(key, agg);
    }
  }

  const [[totals]] = await pool.query(
    `SELECT COUNT(*) AS receipts, COALESCE(SUM(r.total), 0) AS total, COALESCE(SUM(r.discount_total), 0) AS discounts
       FROM ar_receipttab r WHERE ${w}`,
    params
  );
  return {
    from, to, totals, byCenter, byCashier, byMode, byBuyer,
    byLeader: [...byLeader.values()].map((l) => ({ ...l, total: Math.round(l.total * 100) / 100 }))
      .sort((a, b) => a.tree.localeCompare(b.tree) || b.total - a.total),
  };
}

module.exports = { listReceipts, getReceipt, recordPrint, consolidation, centerScope };
