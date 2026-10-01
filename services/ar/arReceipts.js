/**
 * AR receipts: create, approve (which releases codes), void, legacy encoding, sequence seeding.
 *
 * Money-integrity walls (see .claude/rules/money-integrity.md):
 *  - Every status change is a compare-and-swap (`WHERE id = ? AND status = <expected>` + an
 *    affectedRows check), never SELECT-then-UPDATE.
 *  - Approval is ONE transaction under the code-generation lock: CAS pending -> completed, mint the
 *    codes, link them to the AR, and hand them to the recipient. Any failure rolls all of it back.
 *  - Totals are recomputed from the server-side price list. Client-sent prices are never read.
 *  - Raw codes are never returned by this module. Callers get counts only.
 */
const { pool } = require('../../config/database');
const { createProcessKey } = require('../../utils/security');
const { appendActivationCodeUsage } = require('../registrationAudit');
const {
  prepareGenerationRequest,
  allocateCodesInTransaction,
  acquireCodeGenerationLock,
  releaseCodeGenerationLock,
} = require('../codeGeneration');
const {
  MODES, STOCKIST_TYPES, priceReceipt, splitOrder, formatArNo, isValidArNo, isRealIsoDate, manilaYear, validatePayment,
  toCentavos, arError,
} = require('./arPricing');
const { isInBinaryNetwork } = require('./arNetwork');

const RIGHTS = Object.freeze({ SUPER_ADMIN: 1, CASHIER: 2, BOD: 3 });
const PACKAGE_CODE_TYPE = 1;        // paid (PD): an AR is proof of payment
const CODE_STOCKIST_ID = 1;         // matches the Generate Codes route
const MAX_SEQUENCE_SKIPS = 1000;
// Same shape the idempotency middleware accepts. The middleware lets a keyless request through
// (fail-open by design), so the AR create enforces the key itself.
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_LEGACY_QTY = 100000;
const MAX_AMOUNT_CENTAVOS = 999999999999; // DECIMAL(12,2)

function adminFrom(session) {
  const id = Number(session?.adminNumericId || 0);
  const username = String(session?.adminid || '');
  const rights = Number(session?.adminrights || 0);
  if (!id || !username) throw arError('Admin session required', 'AR_FORBIDDEN');
  return { id, username, rights };
}

function requireRights(admin, allowed) {
  if (!allowed.includes(admin.rights)) throw arError('You are not allowed to do this', 'AR_FORBIDDEN');
}

async function writeAudit(conn, { entity, entityId, action, before = null, after = null, admin }) {
  await conn.query(
    `INSERT INTO ar_audittab (entity, entity_id, action, before_json, after_json, actor_admin_id, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entity, String(entityId), action,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
     admin?.id || null, admin?.username || null]
  );
}

async function findMember(conn, username) {
  const name = String(username || '').trim();
  if (!name) return null;
  const [rows] = await conn.query(
    `SELECT m.uid, m.username, CONCAT_WS(' ', m.firstname, m.lastname) AS full_name
       FROM memberstab m WHERE m.username = ? LIMIT 1`,
    [name]
  );
  return rows[0] || null;
}

async function stockistTypeOf(conn, uid) {
  if (!uid) return null;
  const [rows] = await conn.query('SELECT stockist_type FROM ar_stockisttab WHERE uid = ? LIMIT 1', [uid]);
  const type = Number(rows[0]?.stockist_type || 0);
  return STOCKIST_TYPES[type] ? type : null;
}

async function loadPricing(conn) {
  const [priceRows] = await conn.query('SELECT * FROM ar_price_listtab');
  const [discountRows] = await conn.query('SELECT stockist_type, producttype, peso_discount FROM ar_stockist_discounttab');
  return {
    priceList: new Map(priceRows.map((r) => [Number(r.producttype), r])),
    discounts: new Map(discountRows.map((r) => [`${r.stockist_type}:${r.producttype}`, Number(r.peso_discount)])),
  };
}

async function resolveCenter(conn, admin, requestedCenterId) {
  if (admin.rights === RIGHTS.CASHIER) {
    const [rows] = await conn.query('SELECT ar_center_id FROM accesstab WHERE id = ? LIMIT 1', [admin.id]);
    const centerId = Number(rows[0]?.ar_center_id || 0);
    if (!centerId) throw arError('Your cashier account is not assigned to a center yet', 'AR_NO_CENTER');
    return centerId;
  }
  const centerId = Number(requestedCenterId || 0);
  const [rows] = await conn.query('SELECT id FROM ar_centertab WHERE id = ? AND active = 1 LIMIT 1', [centerId]);
  if (!rows.length) throw arError('Choose an active center for this AR');
  return centerId;
}

/** Takes the next AR number under a row lock. Must run inside the caller's transaction. */
async function takeNextArNumber(conn, year) {
  const [rows] = await conn.query('SELECT next_seq FROM ar_sequencetab WHERE id = 1 FOR UPDATE');
  const next = rows[0]?.next_seq;
  if (next == null) {
    throw arError('The AR sequence has not been set. A Super Admin must enter the latest paper AR number first.', 'AR_SEQUENCE_NOT_SEEDED');
  }
  // A legacy AR may already occupy a number; skip forward rather than fail the sale.
  let seq = Number(next);
  for (let i = 0; i < MAX_SEQUENCE_SKIPS; i += 1, seq += 1) {
    const arNo = formatArNo(year, seq);
    const [taken] = await conn.query('SELECT 1 FROM ar_receipttab WHERE ar_no = ? LIMIT 1', [arNo]);
    if (!taken.length) {
      await conn.query('UPDATE ar_sequencetab SET next_seq = ? WHERE id = 1', [seq + 1]);
      return { arNo, seq };
    }
  }
  throw arError('Could not find a free AR number', 'AR_SEQUENCE_EXHAUSTED');
}

async function insertReceipt(conn, row, lines) {
  const [result] = await conn.query(
    `INSERT INTO ar_receipttab
      (ar_no, ar_year, ar_seq, center_id, mode, status, is_legacy, legacy_date, buyer_uid, buyer_name,
       recipient_uid, stockist_type, subtotal, discount_total, total, payment_method, payment_ref, notes,
       prepared_by_admin_id, prepared_by, released_by, client_key, split_group, split_part, split_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.ar_no, row.ar_year, row.ar_seq, row.center_id, row.mode, row.status, row.is_legacy, row.legacy_date,
     row.buyer_uid, row.buyer_name, row.recipient_uid, row.stockist_type, row.subtotal, row.discount_total,
     row.total, row.payment_method, row.payment_ref, row.notes, row.prepared_by_admin_id, row.prepared_by,
     row.released_by, row.client_key ?? null, row.split_group ?? null, row.split_part ?? null, row.split_count ?? null]
  );
  const arId = Number(result.insertId);
  for (const line of lines) {
    await conn.query(
      `INSERT INTO ar_itemtab (ar_id, producttype, description, qty, unit_price, discount_each, line_total, generates_codes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [arId, line.producttype, line.description, line.qty, line.unit_price, line.discount_each, line.line_total, line.generates_codes]
    );
  }
  return arId;
}

/** The AR (or every part of a split order) an admin already created for this intent, or null. */
async function findByClientKey(db, adminId, clientKey) {
  const [rows] = await db.query(
    'SELECT id, ar_no, status, total, split_group FROM ar_receipttab WHERE prepared_by_admin_id = ? AND client_key = ? LIMIT 1',
    [adminId, clientKey]
  );
  const first = rows[0];
  if (!first) return null;
  let parts = [first];
  if (first.split_group) {
    [parts] = await db.query(
      'SELECT id, ar_no, status, total FROM ar_receipttab WHERE prepared_by_admin_id = ? AND split_group = ? ORDER BY split_part',
      [adminId, first.split_group]
    );
  }
  return { ...summarize(parts.map((p) => ({ id: Number(p.id), arNo: p.ar_no, status: p.status, total: Number(p.total) }))), replayed: true };
}

/** Response for a create: the first AR's fields (unchanged shape) plus every part and their sum. */
function summarize(parts) {
  const groupCentavos = parts.reduce((sum, p) => sum + toCentavos(p.total), 0);
  return { ...parts[0], parts, groupTotal: groupCentavos / 100 };
}

const isClientKeyCollision = (error) => error?.code === 'ER_DUP_ENTRY'
  && String(error.sqlMessage || error.message || '').includes('uq_ar_client_key');

/** A member's receipt name comes from the member record, so one account is one buyer in reports. */
const memberName = (member) => String(member.full_name || '').trim() || member.username;

const cleanText = (value, max) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

/**
 * Cashier / Super Admin creates an AR. Code-generating modes wait for approval; SRP and voucher
 * ARs are complete on creation (nothing of value is released by them).
 *
 * With `split: true` a code-generating order above one AR's code limit is saved as consecutive ARs
 * (Part 1 of N...) in ONE transaction: the cashier enters it once, and either every part exists or
 * none does. Each part is approved on its own, so no single approval mints more than 500 codes.
 */
async function createReceipt(session, body = {}, clientKey = '') {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN, RIGHTS.CASHIER]);
  // Without a key a double tap would take two AR numbers for one payment, and approving both
  // would release the codes twice. The key is stored under a UNIQUE index, so a repeat returns the
  // first AR instead of creating another.
  const key = String(clientKey || '');
  if (!CLIENT_KEY_RE.test(key)) throw arError('This request is missing its key. Reload the page and try again.', 'AR_KEY_REQUIRED');
  const previous = await findByClientKey(pool, admin.id, key);
  if (previous) return previous;

  const rule = MODES[body.mode];
  if (!rule) throw arError(`Unknown AR mode: ${body.mode}`);
  validatePayment(body.mode, body.paymentMethod);
  const itemParts = rule.generatesCodes && body.split === true ? splitOrder(body.items) : [body.items];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const centerId = await resolveCenter(conn, admin, body.centerId);

    let buyer = null;
    if (rule.requiresMember || body.buyerUsername) {
      buyer = await findMember(conn, body.buyerUsername);
      if (!buyer) throw arError('Buyer username not found', 'AR_MEMBER_NOT_FOUND');
    }
    const buyerName = buyer ? memberName(buyer) : (cleanText(body.buyerName, 160) || 'Walk-in');

    let recipient = null;
    if (rule.generatesCodes) {
      recipient = body.recipientUsername ? await findMember(conn, body.recipientUsername) : buyer;
      if (!recipient) throw arError('Code recipient username not found', 'AR_MEMBER_NOT_FOUND');
      if (!(await isInBinaryNetwork(conn, buyer.uid, recipient.uid))) {
        throw arError(`${recipient.username} is not in ${buyer.username}'s network`, 'AR_OUTSIDE_NETWORK');
      }
    }

    const stockistType = buyer ? await stockistTypeOf(conn, buyer.uid) : null;
    if (rule.requiresStockist && !stockistType) {
      throw arError(`${buyer.username} is not registered as a stockist`, 'AR_NOT_STOCKIST');
    }

    const { priceList, discounts } = await loadPricing(conn);
    const pricedParts = itemParts.map((items) => priceReceipt({ mode: body.mode, items, priceList, discounts, stockistType }));

    const year = manilaYear();
    const status = rule.generatesCodes ? 'pending_approval' : 'completed';
    const count = pricedParts.length;
    const created = [];
    for (const [index, priced] of pricedParts.entries()) {
      const { arNo, seq } = await takeNextArNumber(conn, year);
      const arId = await insertReceipt(conn, {
        ar_no: arNo, ar_year: year, ar_seq: seq, center_id: centerId, mode: body.mode, status,
        is_legacy: 0, legacy_date: null, buyer_uid: buyer?.uid || null, buyer_name: buyerName,
        recipient_uid: recipient?.uid || null, stockist_type: stockistType,
        subtotal: priced.subtotal, discount_total: priced.discount_total, total: priced.total,
        payment_method: body.paymentMethod, payment_ref: cleanText(body.paymentRef, 120),
        notes: cleanText(body.notes, 500), prepared_by_admin_id: admin.id, prepared_by: admin.username,
        released_by: cleanText(body.releasedBy, 120),
        // Only the first part carries the key, so the UNIQUE index still sees one row per intent.
        client_key: index === 0 ? key : null,
        split_group: count > 1 ? key : null, split_part: count > 1 ? index + 1 : null, split_count: count > 1 ? count : null,
      }, priced.lines);
      await writeAudit(conn, {
        entity: 'ar', entityId: arId, action: 'create', admin,
        after: { arNo, status, total: priced.total, ...(count > 1 ? { part: `${index + 1}/${count}` } : {}) },
      });
      created.push({ id: arId, arNo, status, total: priced.total });
    }

    await conn.commit();
    return summarize(created);
  } catch (error) {
    await conn.rollback();
    if (isClientKeyCollision(error)) {
      // A concurrent request with the same key committed first. Its rollback here also returned the
      // AR numbers this attempt took, so hand back the winner rather than an error.
      const winner = await findByClientKey(pool, admin.id, key);
      if (winner) return winner;
    }
    throw error;
  } finally {
    conn.release();
  }
}

/** Mints the codes for one AR line and hands every one to the recipient, inside `conn`'s transaction. */
async function releaseLineCodes(conn, { receipt, item, recipient, admin }) {
  const request = prepareGenerationRequest(
    item.qty, item.producttype, PACKAGE_CODE_TYPE, CODE_STOCKIST_ID,
    { adminUsername: admin.username, actorAdminId: admin.id },
    // Deterministic per AR line: a second release of the same line can only ever replay.
    { arNumber: receipt.ar_no, idempotencyKey: `ar-${receipt.id}-line-${item.id}` }
  );
  const minted = await allocateCodesInTransaction(conn, request);
  if (minted.replayed) {
    throw arError(`Codes for AR ${receipt.ar_no} line ${item.id} were already generated`, 'AR_ALREADY_RELEASED');
  }

  for (const { id: codeId, code } of minted.rows) {
    // CAS: only a freshly minted, unreleased, unowned code may be handed out.
    const [owned] = await conn.query(
      'UPDATE codestab SET releasedate = 1, codestatus = 1, uid = ? WHERE id = ? AND codestatus = 0 AND uid IS NULL LIMIT 1',
      [recipient.uid, codeId]
    );
    if (owned.affectedRows !== 1) throw arError(`Code ${codeId} could not be released`, 'AR_RELEASE_CONFLICT');

    await conn.query(
      'INSERT INTO ar_code_linktab (ar_id, ar_item_id, code_id) VALUES (?, ?, ?)',
      [receipt.id, item.id, codeId]
    );
    await conn.query(
      `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
       VALUES (?, ?, NOW(), ?, NOW(), NULL)`,
      [codeId, code, `(${admin.username})${recipient.username}`]
    );
    await appendActivationCodeUsage(conn, {
      code, codeRowId: codeId, eventType: 'release', toUid: recipient.uid, actorAdminId: admin.id,
      notes: { arNo: receipt.ar_no }, processKey: createProcessKey(['ar-release', receipt.id, codeId]),
    });
    await appendActivationCodeUsage(conn, {
      code, codeRowId: codeId, eventType: 'admin_transfer', toUid: recipient.uid, actorAdminId: admin.id,
      notes: { arNo: receipt.ar_no, targetUsername: recipient.username, viaAr: true },
      processKey: createProcessKey(['ar-transfer', receipt.id, codeId]),
    });
  }
  return minted.rows.length;
}

/** Super Admin approves a pending AR: codes are generated and transferred in one transaction. */
async function approveReceipt(session, arId) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN]);
  const id = Number(arId);
  if (!Number.isInteger(id) || id <= 0) throw arError('Invalid AR id');

  const conn = await pool.getConnection();
  let lockAcquired = false;
  let txStarted = false;
  try {
    lockAcquired = await acquireCodeGenerationLock(conn);
    if (!lockAcquired) throw arError('Code generation is busy. Please retry in a moment.', 'AR_BUSY');
    await conn.beginTransaction();
    txStarted = true;

    const [[receipt]] = await conn.query('SELECT * FROM ar_receipttab WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    if (!receipt) throw arError('AR not found', 'AR_NOT_FOUND');
    if (receipt.status !== 'pending_approval') {
      throw arError(`AR ${receipt.ar_no} is ${receipt.status.replace('_', ' ')}, not awaiting approval`, 'AR_WRONG_STATUS');
    }

    const [[recipient]] = await conn.query(
      'SELECT uid, username FROM memberstab WHERE uid = ? LIMIT 1', [receipt.recipient_uid]
    );
    if (!recipient) throw arError('Code recipient no longer exists', 'AR_MEMBER_NOT_FOUND');
    // Re-checked at release: the tree can change between the sale and the approval.
    if (!(await isInBinaryNetwork(conn, receipt.buyer_uid, recipient.uid))) {
      throw arError(`${recipient.username} is no longer in the buyer's network`, 'AR_OUTSIDE_NETWORK');
    }

    const [items] = await conn.query('SELECT * FROM ar_itemtab WHERE ar_id = ? AND generates_codes = 1 ORDER BY id', [id]);
    let released = 0;
    for (const item of items) {
      released += await releaseLineCodes(conn, { receipt, item, recipient, admin });
    }

    const [cas] = await conn.query(
      `UPDATE ar_receipttab
          SET status = 'completed', approved_by_admin_id = ?, approved_by = ?, approved_at = NOW(6), release_error = NULL
        WHERE id = ? AND status = 'pending_approval'`,
      [admin.id, admin.username, id]
    );
    if (cas.affectedRows !== 1) throw arError('This AR was changed by someone else. Refresh and try again.', 'AR_WRONG_STATUS');

    await writeAudit(conn, { entity: 'ar', entityId: id, action: 'approve', after: { codesReleased: released }, admin });
    await conn.commit();
    txStarted = false;
    return { id, arNo: receipt.ar_no, status: 'completed', codesReleased: released };
  } catch (error) {
    if (txStarted) await conn.rollback();
    // Record why it failed so the queue can show it; best-effort, outside the rolled-back work.
    if (error.code !== 'AR_WRONG_STATUS' && error.code !== 'AR_NOT_FOUND') {
      await pool.query(
        "UPDATE ar_receipttab SET release_error = ? WHERE id = ? AND status = 'pending_approval'",
        [String(error.message).slice(0, 255), id]
      ).catch(() => {});
    }
    throw error;
  } finally {
    let reusable = true;
    if (lockAcquired) {
      try { await releaseCodeGenerationLock(conn); } catch { reusable = false; conn.destroy(); }
    }
    if (reusable) conn.release();
  }
}

/**
 * Voids an AR. Cashiers may void only a pending AR they prepared. Super Admin may void any pending or
 * completed AR. Voiding a completed AR does NOT take back codes it already released: they belong to
 * the recipient. The AR simply drops out of reports. Any open flag on it is resolved as voided.
 */
async function voidReceipt(session, arId, reason) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN, RIGHTS.CASHIER]);
  const why = cleanText(reason, 255);
  if (!why) throw arError('A reason is required to void an AR');
  return inTransaction(async (conn) => {
    await voidInTransaction(conn, admin, arId, why);
    await closeOpenFlag(conn, admin, arId, 'voided', why);
    return { id: Number(arId), status: 'void' };
  });
}

async function voidInTransaction(conn, admin, arId, why) {
  const isSuper = admin.rights === RIGHTS.SUPER_ADMIN ? 1 : 0;
  const [cas] = await conn.query(
    `UPDATE ar_receipttab
        SET status = 'void', void_reason = ?, voided_by = ?, voided_at = NOW(6)
      WHERE id = ? AND ((? = 1 AND status IN ('pending_approval', 'completed'))
                        OR (status = 'pending_approval' AND prepared_by_admin_id = ?))`,
    [why, admin.username, Number(arId), isSuper, admin.id]
  );
  if (cas.affectedRows !== 1) {
    throw arError(isSuper ? 'This AR is already void or does not exist' : 'Only a pending AR you prepared can be voided', 'AR_WRONG_STATUS');
  }
  await writeAudit(conn, { entity: 'ar', entityId: arId, action: 'void', after: { reason: why }, admin });
}

/** Resolves the AR's open flag, if it has one. Returns whether a flag was closed. */
async function closeOpenFlag(conn, admin, arId, resolution, note) {
  const [res] = await conn.query(
    `UPDATE ar_flagtab
        SET open_ar_id = NULL, resolution = ?, resolution_note = ?, resolved_by_admin_id = ?, resolved_by = ?, resolved_at = NOW(6)
      WHERE open_ar_id = ?`,
    [resolution, note, admin.id, admin.username, Number(arId)]
  );
  if (res.affectedRows === 1) {
    await writeAudit(conn, { entity: 'ar_flag', entityId: arId, action: `resolve_${resolution}`, after: { note }, admin });
  }
  return res.affectedRows === 1;
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

/**
 * A cashier (own center) or Super Admin marks a COMPLETED AR as having a mistake, e.g. found after the
 * items were delivered. It changes nothing on the AR; it only puts it in front of a Super Admin, who
 * decides whether to void it or keep it. One open flag per AR (UNIQUE open_ar_id).
 */
async function flagReceipt(session, arId, reason) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN, RIGHTS.CASHIER]);
  const why = cleanText(reason, 500);
  if (!why) throw arError('Describe the mistake so the Super Admin can review it');
  const id = Number(arId);
  if (!Number.isInteger(id) || id <= 0) throw arError('Invalid AR id');

  return inTransaction(async (conn) => {
    // Row lock: a void racing this flag must not leave an open flag on a void AR.
    const [[receipt]] = await conn.query('SELECT id, ar_no, status, center_id FROM ar_receipttab WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    if (admin.rights === RIGHTS.CASHIER) {
      const [[me]] = await conn.query('SELECT ar_center_id FROM accesstab WHERE id = ? LIMIT 1', [admin.id]);
      if (!receipt || Number(me?.ar_center_id || 0) !== Number(receipt.center_id)) throw arError('AR not found', 'AR_NOT_FOUND');
    }
    if (!receipt) throw arError('AR not found', 'AR_NOT_FOUND');
    if (receipt.status !== 'completed') {
      throw arError(receipt.status === 'void' ? 'This AR is already void' : 'A pending AR can be voided instead of flagged', 'AR_WRONG_STATUS');
    }
    try {
      const [ins] = await conn.query(
        'INSERT INTO ar_flagtab (ar_id, open_ar_id, reason, raised_by_admin_id, raised_by) VALUES (?, ?, ?, ?, ?)',
        [id, id, why, admin.id, admin.username]
      );
      await writeAudit(conn, { entity: 'ar_flag', entityId: id, action: 'raise', after: { reason: why }, admin });
      return { id, flagId: Number(ins.insertId), flagged: true };
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') throw arError(`AR ${receipt.ar_no} already has an open flag`, 'AR_ALREADY_FLAGGED');
      throw error;
    }
  });
}

/** Super Admin decides on a flagged AR: void it, or keep it as is. Both close the flag. */
async function resolveFlag(session, arId, body = {}) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN]);
  const resolution = String(body.resolution || '');
  if (!['kept', 'voided'].includes(resolution)) throw arError('Choose whether to void the AR or keep it');
  const note = cleanText(body.note, resolution === 'voided' ? 255 : 500);
  if (!note) throw arError(resolution === 'voided' ? 'A reason is required to void an AR' : 'Add a note explaining why the AR is kept');

  return inTransaction(async (conn) => {
    if (resolution === 'voided') await voidInTransaction(conn, admin, arId, note);
    if (!(await closeOpenFlag(conn, admin, arId, resolution, note))) {
      throw arError('This AR has no open flag (someone may have resolved it already)', 'AR_NO_OPEN_FLAG');
    }
    return { id: Number(arId), resolution, status: resolution === 'voided' ? 'void' : 'completed' };
  });
}

/**
 * Super Admin encodes an old paper AR so it appears in reports. Amounts are taken as written on the
 * paper (historical prices may differ from today's list). Never generates codes.
 */
async function createLegacyReceipt(session, body = {}) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN]);
  const arNo = String(body.arNo || '').trim();
  if (!isValidArNo(arNo)) throw arError('The paper AR number must be digits only');
  const legacyDate = String(body.legacyDate || '');
  if (!isRealIsoDate(legacyDate)) throw arError('Enter the real date written on the paper AR (YYYY-MM-DD)');
  if (!MODES[body.mode]) throw arError(`Unknown AR mode: ${body.mode}`);
  if (!Array.isArray(body.items) || !body.items.length) throw arError('Enter at least one item');

  const lines = body.items.map((raw) => {
    const qty = Number(raw?.qty);
    const unit = toCentavos(raw?.unitPrice);
    const description = cleanText(raw?.description, 160);
    if (!description) throw arError('Each legacy item needs a description');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LEGACY_QTY) {
      throw arError(`Legacy quantities must be whole numbers from 1 to ${MAX_LEGACY_QTY}`);
    }
    if (!Number.isInteger(unit) || unit < 0 || unit * qty > MAX_AMOUNT_CENTAVOS) {
      throw arError('Legacy prices must be zero or more and within the receipt limit');
    }
    return {
      producttype: Number.isInteger(Number(raw?.producttype)) ? Number(raw.producttype) : 0,
      description, qty, unit_price: unit / 100, discount_each: 0, line_total: (unit * qty) / 100, generates_codes: 0,
    };
  });
  const totalCentavos = lines.reduce((s, l) => s + toCentavos(l.line_total), 0);
  if (totalCentavos > MAX_AMOUNT_CENTAVOS) throw arError('The legacy AR total is above the receipt limit');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const centerId = await resolveCenter(conn, admin, body.centerId);
    const buyer = body.buyerUsername ? await findMember(conn, body.buyerUsername) : null;
    if (body.buyerUsername && !buyer) throw arError('Buyer username not found', 'AR_MEMBER_NOT_FOUND');
    const [taken] = await conn.query('SELECT 1 FROM ar_receipttab WHERE ar_no = ? LIMIT 1', [arNo]);
    if (taken.length) throw arError(`AR ${arNo} is already recorded`, 'AR_DUPLICATE_NUMBER');

    const arId = await insertReceipt(conn, {
      ar_no: arNo, ar_year: Number(legacyDate.slice(0, 4)), ar_seq: null, center_id: centerId, mode: body.mode,
      status: 'completed', is_legacy: 1, legacy_date: legacyDate, buyer_uid: buyer?.uid || null,
      buyer_name: buyer ? memberName(buyer) : (cleanText(body.buyerName, 160) || 'Walk-in'), recipient_uid: null,
      stockist_type: null, subtotal: totalCentavos / 100, discount_total: 0, total: totalCentavos / 100,
      payment_method: MODES[body.mode].voucherOnly ? 'voucher' : 'cash', payment_ref: cleanText(body.paymentRef, 120),
      notes: cleanText(body.notes, 500), prepared_by_admin_id: admin.id, prepared_by: admin.username,
      released_by: cleanText(body.releasedBy, 120),
    }, lines);
    await writeAudit(conn, { entity: 'ar', entityId: arId, action: 'legacy_encode', after: { arNo, legacyDate }, admin });
    await conn.commit();
    return { id: arId, arNo, status: 'completed' };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Sets the start of the live sequence from the latest PAPER AR number. Allowed only until the first
 * live AR exists, so the numbering can never be moved underneath issued receipts.
 */
async function seedSequence(session, latestPaperSeq) {
  const admin = adminFrom(session);
  requireRights(admin, [RIGHTS.SUPER_ADMIN]);
  const latest = Number(latestPaperSeq);
  if (!Number.isInteger(latest) || latest < 0 || latest > 999999999) {
    throw arError('Enter the latest paper AR number as a whole number');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[seqRow]] = await conn.query('SELECT next_seq, seeded_from FROM ar_sequencetab WHERE id = 1 FOR UPDATE');
    const [[live]] = await conn.query('SELECT COUNT(*) AS n FROM ar_receipttab WHERE is_legacy = 0');
    if (Number(live.n) > 0) {
      throw arError('The sequence is locked: live ARs have already been issued', 'AR_SEQUENCE_LOCKED');
    }
    await conn.query(
      'UPDATE ar_sequencetab SET next_seq = ?, seeded_from = ?, seeded_by = ?, seeded_at = NOW() WHERE id = 1',
      [latest + 1, latest, admin.username]
    );
    await writeAudit(conn, {
      entity: 'ar_sequence', entityId: 1, action: 'seed', before: seqRow || null,
      after: { next_seq: latest + 1, seeded_from: latest }, admin,
    });
    await conn.commit();
    return { nextSeq: latest + 1, seededFrom: latest };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  RIGHTS,
  createReceipt,
  approveReceipt,
  voidReceipt,
  flagReceipt,
  resolveFlag,
  createLegacyReceipt,
  seedSequence,
  // exported for tests
  takeNextArNumber,
  adminFrom,
};
