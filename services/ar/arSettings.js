/**
 * AR settings managed by Super Admin: price list, stockist package discounts, the AR-only stockist
 * registry, and cashier-to-center binding. Every change is audited with before/after values.
 * Past ARs are never touched: each receipt line holds its own price snapshot.
 */
const { pool } = require('../../config/database');
const { STOCKIST_TYPES, isPackageType, isProductType, toCentavos, arError } = require('./arPricing');

async function audit(conn, entity, entityId, action, before, after, admin) {
  await conn.query(
    `INSERT INTO ar_audittab (entity, entity_id, action, before_json, after_json, actor_admin_id, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entity, String(entityId), action, before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, admin.id || null, admin.username || null]
  );
}

function money(value, label) {
  const c = toCentavos(value);
  if (!Number.isInteger(c) || c < 0 || c > 99999999999) throw arError(`${label} must be zero or more`);
  return c / 100;
}

/** Omitted means active (a new price row is sellable); anything but a real boolean is refused. */
function parseActive(value) {
  if (value === undefined || value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw arError('Active must be true or false');
}

async function inTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

// ── Price list ──────────────────────────────────────────────────────────────

async function listPrices() {
  const [rows] = await pool.query('SELECT * FROM ar_price_listtab ORDER BY producttype');
  return rows;
}

async function upsertPrice(admin, body = {}) {
  const pt = Number(body.producttype);
  if (!isPackageType(pt) && !isProductType(pt)) throw arError('Unknown package or product');
  const itemName = String(body.itemName || '').trim().slice(0, 120);
  if (!itemName) throw arError('Item name is required');
  const next = {
    item_name: itemName,
    member_price: money(body.memberPrice, 'Member price'),
    stockist_price: money(body.stockistPrice, 'Stockist price'),
    srp: money(body.srp, 'SRP'),
    active: parseActive(body.active),
  };
  return inTransaction(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM ar_price_listtab WHERE producttype = ? FOR UPDATE', [pt]);
    await conn.query(
      `INSERT INTO ar_price_listtab (producttype, item_name, member_price, stockist_price, srp, active, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE item_name = VALUES(item_name), member_price = VALUES(member_price),
         stockist_price = VALUES(stockist_price), srp = VALUES(srp), active = VALUES(active),
         updated_by = VALUES(updated_by)`,
      [pt, next.item_name, next.member_price, next.stockist_price, next.srp, next.active, admin.username]
    );
    await audit(conn, 'price', pt, before ? 'update' : 'create', before || null, next, admin);
    return { producttype: pt, ...next };
  });
}

// ── Stockist package discounts ──────────────────────────────────────────────

async function listDiscounts() {
  const [rows] = await pool.query('SELECT * FROM ar_stockist_discounttab ORDER BY stockist_type DESC, producttype');
  return rows;
}

async function setDiscount(admin, body = {}) {
  const type = Number(body.stockistType);
  const pt = Number(body.producttype);
  if (!STOCKIST_TYPES[type]) throw arError('Unknown stockist type');
  if (!isPackageType(pt)) throw arError('Stockist discounts apply to packages only');
  const pesoDiscount = money(body.pesoDiscount, 'Discount');
  return inTransaction(async (conn) => {
    const [[before]] = await conn.query(
      'SELECT * FROM ar_stockist_discounttab WHERE stockist_type = ? AND producttype = ? FOR UPDATE', [type, pt]
    );
    await conn.query(
      `INSERT INTO ar_stockist_discounttab (stockist_type, producttype, peso_discount, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE peso_discount = VALUES(peso_discount), updated_by = VALUES(updated_by)`,
      [type, pt, pesoDiscount, admin.username]
    );
    await audit(conn, 'discount', `${type}:${pt}`, 'set', before || null, { pesoDiscount }, admin);
    return { stockistType: type, producttype: pt, pesoDiscount };
  });
}

// ── AR-only stockist registry ───────────────────────────────────────────────

async function listStockists() {
  const [rows] = await pool.query(
    `SELECT s.uid, m.username, CONCAT_WS(' ', m.firstname, m.lastname) AS full_name, s.stockist_type, s.set_by, s.set_at
       FROM ar_stockisttab s JOIN memberstab m ON m.uid = s.uid
      ORDER BY s.stockist_type DESC, m.username`
  );
  return rows;
}

async function setStockist(admin, body = {}) {
  const username = String(body.username || '').trim();
  const type = Number(body.stockistType);
  return inTransaction(async (conn) => {
    const [[member]] = await conn.query('SELECT uid, username FROM memberstab WHERE username = ? LIMIT 1', [username]);
    if (!member) throw arError('Member username not found', 'AR_MEMBER_NOT_FOUND');
    const [[before]] = await conn.query('SELECT * FROM ar_stockisttab WHERE uid = ? FOR UPDATE', [member.uid]);
    if (type === 0) {
      await conn.query('DELETE FROM ar_stockisttab WHERE uid = ?', [member.uid]);
      await audit(conn, 'stockist', member.uid, 'remove', before || null, null, admin);
      return { uid: member.uid, username: member.username, stockistType: null };
    }
    if (!STOCKIST_TYPES[type]) throw arError('Unknown stockist type');
    await conn.query(
      `INSERT INTO ar_stockisttab (uid, stockist_type, set_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE stockist_type = VALUES(stockist_type), set_by = VALUES(set_by)`,
      [member.uid, type, admin.username]
    );
    await audit(conn, 'stockist', member.uid, before ? 'update' : 'create', before || null, { stockistType: type }, admin);
    return { uid: member.uid, username: member.username, stockistType: type };
  });
}

/** One member plus their AR stockist type, for the cashier's buyer lookup. */
async function lookupMember(username) {
  const [[row]] = await pool.query(
    `SELECT m.uid, m.username, CONCAT_WS(' ', m.firstname, m.lastname) AS full_name, s.stockist_type
       FROM memberstab m LEFT JOIN ar_stockisttab s ON s.uid = m.uid
      WHERE m.username = ? LIMIT 1`,
    [String(username || '').trim()]
  );
  if (!row) throw arError('Member not found', 'AR_NOT_FOUND');
  return { uid: row.uid, username: row.username, full_name: row.full_name, stockistType: row.stockist_type ? Number(row.stockist_type) : null };
}

// ── Centers and cashier binding ─────────────────────────────────────────────

async function listCenters() {
  const [rows] = await pool.query('SELECT * FROM ar_centertab ORDER BY id');
  return rows;
}

async function listCashiers() {
  const [rows] = await pool.query(
    `SELECT a.id, a.username, a.name, a.rights, a.ar_center_id, c.name AS center_name
       FROM accesstab a LEFT JOIN ar_centertab c ON c.id = a.ar_center_id
      WHERE a.rights IN (1, 2) ORDER BY a.rights, a.username`
  );
  return rows;
}

async function assignCashierCenter(admin, body = {}) {
  const accessId = Number(body.accessId);
  const centerId = body.centerId == null || body.centerId === '' ? null : Number(body.centerId);
  return inTransaction(async (conn) => {
    const [[account]] = await conn.query('SELECT id, username, rights, ar_center_id FROM accesstab WHERE id = ? FOR UPDATE', [accessId]);
    if (!account) throw arError('Account not found');
    if (Number(account.rights) !== 2) throw arError('Only cashier accounts are bound to a center');
    if (centerId !== null) {
      const [[center]] = await conn.query('SELECT id FROM ar_centertab WHERE id = ? AND active = 1', [centerId]);
      if (!center) throw arError('Choose an active center');
    }
    await conn.query('UPDATE accesstab SET ar_center_id = ? WHERE id = ?', [centerId, accessId]);
    await audit(conn, 'cashier_center', accessId, 'assign', { centerId: account.ar_center_id }, { centerId }, admin);
    return { accessId, username: account.username, centerId };
  });
}

async function sequenceStatus() {
  const [[row]] = await pool.query('SELECT next_seq, seeded_from, seeded_by, seeded_at FROM ar_sequencetab WHERE id = 1');
  const [[live]] = await pool.query('SELECT COUNT(*) AS n FROM ar_receipttab WHERE is_legacy = 0');
  return { ...(row || {}), seeded: row?.next_seq != null, locked: Number(live.n) > 0 };
}

module.exports = {
  listPrices, upsertPrice, listDiscounts, setDiscount, listStockists, setStockist, lookupMember,
  listCenters, listCashiers, assignCashierCenter, sequenceStatus,
};
