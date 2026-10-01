'use strict';
/**
 * In-memory stand-in for the tables the AR services touch. Not a SQL engine: each statement the
 * services issue is matched by its leading text and applied to plain arrays.
 *
 * Semantics that matter for the money tests are modelled deliberately:
 *  - beginTransaction snapshots state; rollback restores it; commit keeps it.
 *  - `... FOR UPDATE` takes one row-lock mutex held until commit/rollback, and GET_LOCK takes a
 *    named mutex held until RELEASE_LOCK, so parallel callers genuinely serialize.
 *  - UPDATEs return affectedRows so compare-and-swap checks behave as they do in MySQL.
 * Writes only happen after a lock in the services under test, which is what makes the
 * whole-state snapshot/restore safe for the concurrency cases exercised here.
 */

function mutex() {
  let owner = null;
  const waiters = [];
  return {
    get owner() { return owner; },
    async acquire(who) {
      if (owner === who) return;
      while (owner !== null) await new Promise((resolve) => waiters.push(resolve));
      owner = who;
    },
    release(who) {
      if (owner !== who) return;
      owner = null;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

function createFakeDb(seed = {}) {
  const db = {
    members: seed.members || [],          // { uid, username, firstname, lastname, refid }
    access: seed.access || [],            // { id, username, rights, ar_center_id }
    centers: seed.centers || [{ id: 1, code: 'CAL', name: 'Caloocan', active: 1 }, { id: 2, code: 'TYC', name: 'Tycoon', active: 1 }],
    seq: { next_seq: seed.nextSeq === undefined ? 1001 : seed.nextSeq, seeded_from: null },
    stockists: seed.stockists || [],      // { uid, stockist_type }
    prices: seed.prices || [],            // ar_price_listtab rows
    discounts: seed.discounts || [],      // { stockist_type, producttype, peso_discount }
    receipts: [], items: [], links: [], codes: [], batches: [], batchCodes: [], flags: [],
    history: [], events: [], audits: [],
  };
  let nextIds = { receipt: 1, item: 1, code: 9000, batch: 1, flag: 1 };
  // Test hooks live OUTSIDE the snapshot, so a rollback cannot re-arm them.
  const hooks = { failCodeCasOnce: false };
  const rowLock = mutex();
  const genLock = mutex();
  const clone = () => JSON.parse(JSON.stringify({ db, nextIds }));
  const restore = (snap) => { Object.assign(db, snap.db); nextIds = snap.nextIds; };

  function makeConn(name) {
    let snapshot = null;
    let wrote = false;
    const conn = {
      name,
      async query(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/FOR UPDATE/.test(q)) {
          const first = rowLock.owner !== conn;
          await rowLock.acquire(conn);
          // Rollback must undo only THIS transaction's writes. Snapshotting at BEGIN would also undo
          // rows another transaction committed while this one waited for the lock.
          if (first && snapshot && !wrote) snapshot = clone();
        }
        if (/^(INSERT|UPDATE|DELETE)/.test(q)) wrote = true;
        return run(q, params);
      },
      async beginTransaction() { snapshot = clone(); wrote = false; },
      async commit() { snapshot = null; rowLock.release(conn); },
      async rollback() { if (snapshot) restore(snapshot); snapshot = null; rowLock.release(conn); },
      release() { rowLock.release(conn); },
      destroy() { rowLock.release(conn); },
    };

    function run(q, p) {
      // ── locks
      if (q.startsWith('SELECT GET_LOCK')) return genLock.acquire(conn).then(() => [[{ lockState: 1 }]]);
      if (q.startsWith('SELECT RELEASE_LOCK')) { genLock.release(conn); return [[{}]]; }

      // ── members / access / centers
      if (q.startsWith('SELECT m.uid, m.username, CONCAT_WS')) {
        const m = db.members.find((x) => x.username === p[0]);
        return [m ? [{ uid: m.uid, username: m.username, full_name: `${m.firstname} ${m.lastname}` }] : []];
      }
      if (q.startsWith('SELECT uid, username FROM memberstab WHERE uid')) {
        const m = db.members.find((x) => x.uid === p[0]);
        return [m ? [{ uid: m.uid, username: m.username }] : []];
      }
      if (q.startsWith('SELECT ar_center_id FROM accesstab')) {
        const a = db.access.find((x) => x.id === p[0]);
        return [a ? [{ ar_center_id: a.ar_center_id }] : []];
      }
      if (q.startsWith('SELECT id FROM ar_centertab')) return [db.centers.filter((c) => c.id === p[0] && c.active)];
      if (q.startsWith('SELECT stockist_type FROM ar_stockisttab')) return [db.stockists.filter((s) => s.uid === p[0])];
      if (q.startsWith('SELECT * FROM ar_price_listtab')) return [db.prices];
      if (q.startsWith('SELECT stockist_type, producttype, peso_discount')) return [db.discounts];

      // ── binary network walk (recipient, buyer)
      if (q.startsWith('WITH RECURSIVE chain')) {
        const [recipient, buyer] = p;
        let cur = db.members.find((x) => x.uid === recipient);
        for (let depth = 0; cur && depth < 5000; depth += 1) {
          if (cur.uid === buyer) return [[{ found: 1 }]];
          cur = db.members.find((x) => x.uid === cur.refid);
        }
        return [[]];
      }

      // ── sequence
      if (q.startsWith('SELECT next_seq, seeded_from FROM ar_sequencetab')) return [[{ ...db.seq }]];
      if (q.startsWith('SELECT next_seq FROM ar_sequencetab')) return [[{ next_seq: db.seq.next_seq }]];
      if (q.startsWith('UPDATE ar_sequencetab SET next_seq = ?, seeded_from')) {
        db.seq.next_seq = p[0]; db.seq.seeded_from = p[1]; return [{ affectedRows: 1 }];
      }
      if (q.startsWith('UPDATE ar_sequencetab SET next_seq')) { db.seq.next_seq = p[0]; return [{ affectedRows: 1 }]; }
      if (q.startsWith('SELECT COUNT(*) AS n FROM ar_receipttab WHERE is_legacy = 0')) {
        return [[{ n: db.receipts.filter((r) => !r.is_legacy).length }]];
      }

      // ── receipts
      if (q.startsWith('SELECT 1 FROM ar_receipttab WHERE ar_no')) return [db.receipts.filter((r) => r.ar_no === p[0])];
      if (q.startsWith('INSERT INTO ar_receipttab')) {
        const cols = ['ar_no', 'ar_year', 'ar_seq', 'center_id', 'mode', 'status', 'is_legacy', 'legacy_date', 'buyer_uid', 'buyer_name',
          'recipient_uid', 'stockist_type', 'subtotal', 'discount_total', 'total', 'payment_method', 'payment_ref', 'notes',
          'prepared_by_admin_id', 'prepared_by', 'released_by', 'client_key', 'split_group', 'split_part', 'split_count'];
        if (db.receipts.some((r) => r.ar_no === p[0])) throw Object.assign(new Error('dup ar_no'), { code: 'ER_DUP_ENTRY' });
        const [adminId, key] = [p[18], p[21]];
        if (key != null && db.receipts.some((r) => r.prepared_by_admin_id === adminId && r.client_key === key)) {
          throw Object.assign(new Error('dup client key'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry for key 'uq_ar_client_key'" });
        }
        const row = { id: nextIds.receipt++ };
        cols.forEach((c, i) => { row[c] = p[i]; });
        db.receipts.push(row);
        return [{ insertId: row.id }];
      }
      if (q.startsWith('SELECT id, ar_no, status, total, split_group FROM ar_receipttab WHERE prepared_by_admin_id = ? AND client_key = ?')) {
        return [db.receipts.filter((r) => r.prepared_by_admin_id === p[0] && r.client_key === p[1]).map((r) => ({ ...r }))];
      }
      if (q.startsWith('SELECT id, ar_no, status, total FROM ar_receipttab WHERE prepared_by_admin_id = ? AND split_group = ?')) {
        return [db.receipts.filter((r) => r.prepared_by_admin_id === p[0] && r.split_group === p[1])
          .sort((a, b) => a.split_part - b.split_part).map((r) => ({ ...r }))];
      }
      if (q.startsWith('SELECT id, ar_no, status, center_id FROM ar_receipttab WHERE id')) {
        return [db.receipts.filter((r) => r.id === p[0]).map((r) => ({ ...r }))];
      }
      if (q.startsWith('SELECT * FROM ar_receipttab WHERE id')) return [db.receipts.filter((r) => r.id === p[0]).map((r) => ({ ...r }))];
      if (q.startsWith("UPDATE ar_receipttab SET status = 'completed'")) {
        const r = db.receipts.find((x) => x.id === p[2] && x.status === 'pending_approval');
        if (!r) return [{ affectedRows: 0 }];
        Object.assign(r, { status: 'completed', approved_by_admin_id: p[0], approved_by: p[1], release_error: null });
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith("UPDATE ar_receipttab SET status = 'void'")) {
        const [reason, by, id, isSuper, adminId] = p;
        const r = db.receipts.find((x) => x.id === id && ((isSuper === 1 && ['pending_approval', 'completed'].includes(x.status))
          || (x.status === 'pending_approval' && x.prepared_by_admin_id === adminId)));
        if (!r) return [{ affectedRows: 0 }];
        Object.assign(r, { status: 'void', void_reason: reason, voided_by: by });
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('UPDATE ar_receipttab SET release_error')) {
        const r = db.receipts.find((x) => x.id === p[1] && x.status === 'pending_approval');
        if (r) r.release_error = p[0];
        return [{ affectedRows: r ? 1 : 0 }];
      }

      // ── items
      if (q.startsWith('INSERT INTO ar_itemtab')) {
        const [ar_id, producttype, description, qty, unit_price, discount_each, line_total, generates_codes] = p;
        const row = { id: nextIds.item++, ar_id, producttype, description, qty, unit_price, discount_each, line_total, generates_codes };
        db.items.push(row);
        return [{ insertId: row.id }];
      }
      if (q.startsWith('SELECT * FROM ar_itemtab WHERE ar_id = ? AND generates_codes = 1')) {
        return [db.items.filter((i) => i.ar_id === p[0] && i.generates_codes === 1).map((i) => ({ ...i }))];
      }

      // ── code generator (mirrors codeGenerationTransaction.test.js)
      if (q.startsWith('SELECT * FROM code_generation_batchtab') || q.startsWith('SELECT request_hash, status, codes_json FROM code_generation_batchtab')) {
        return [db.batches.filter((b) => b.actor === p[0] && b.key === p[1])];
      }
      if (q.startsWith('INSERT INTO code_generation_batchtab')) {
        if (db.batches.some((b) => b.actor === p[1] && b.key === p[0])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
        db.batches.push({ id: nextIds.batch++, key: p[0], actor: p[1], ar_number: p[3], request_hash: p[4], status: 'processing', codes_json: null });
        return [{}];
      }
      if (q.startsWith('SELECT id FROM code_generation_batchtab')) return [[db.batches.find((b) => b.actor === p[0] && b.key === p[1])]];
      if (q.startsWith('SELECT MAX(id) AS maxId FROM codestab')) return [[{ maxId: 1000 + db.codes.length }]];
      if (q.startsWith('SELECT id FROM codestab WHERE code')) return [db.codes.filter((c) => c.code === p[0])];
      if (q.startsWith('INSERT INTO codestab')) {
        const row = { id: nextIds.code++, code: p[0], producttype: p[1], codestatus: 0, uid: null };
        db.codes.push(row);
        return [{ insertId: row.id }];
      }
      if (q.startsWith('INSERT INTO code_generation_batch_codetab')) { db.batchCodes.push(p); return [{}]; }
      if (q.startsWith('UPDATE code_generation_batchtab SET status')) {
        const b = db.batches.find((x) => x.id === p[1]);
        b.status = 'completed'; b.codes_json = p[0];
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('UPDATE codestab SET releasedate = 1, codestatus = 1, uid = ?')) {
        if (hooks.failCodeCasOnce) { hooks.failCodeCasOnce = false; return [{ affectedRows: 0 }]; }
        const c = db.codes.find((x) => x.id === p[1] && x.codestatus === 0 && x.uid === null);
        if (!c) return [{ affectedRows: 0 }];
        c.codestatus = 1; c.uid = p[0];
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('INSERT INTO ar_code_linktab')) {
        if (db.links.some((l) => l.code_id === p[2])) throw Object.assign(new Error('dup code link'), { code: 'ER_DUP_ENTRY' });
        db.links.push({ ar_id: p[0], ar_item_id: p[1], code_id: p[2] });
        return [{}];
      }
      if (q.startsWith('INSERT INTO codehistorytab')) { db.history.push(p); return [{}]; }
      if (q.startsWith('INSERT IGNORE INTO activation_code_usagetab')) { db.events.push({ code: p[0], type: p[2], to: p[4] }); return [{}]; }
      // ── flags (UNIQUE open_ar_id: one open flag per AR)
      if (q.startsWith('INSERT INTO ar_flagtab')) {
        const [ar_id, open_ar_id, reason, byId, by] = p;
        if (db.flags.some((f) => f.open_ar_id === open_ar_id)) throw Object.assign(new Error('dup open flag'), { code: 'ER_DUP_ENTRY' });
        const row = { id: nextIds.flag++, ar_id, open_ar_id, reason, raised_by_admin_id: byId, raised_by: by, resolution: null };
        db.flags.push(row);
        return [{ insertId: row.id }];
      }
      if (q.startsWith('UPDATE ar_flagtab SET open_ar_id = NULL')) {
        const [resolution, note, byId, by, arId] = p;
        const f = db.flags.find((x) => x.open_ar_id === arId);
        if (!f) return [{ affectedRows: 0 }];
        Object.assign(f, { open_ar_id: null, resolution, resolution_note: note, resolved_by_admin_id: byId, resolved_by: by });
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('INSERT INTO ar_audittab')) { db.audits.push({ entity: p[0], id: p[1], action: p[2] }); return [{}]; }

      throw new Error(`fake db: unhandled SQL: ${q.slice(0, 90)}`);
    }
    return conn;
  }

  let connCount = 0;
  const pool = {
    async getConnection() { connCount += 1; return makeConn(`c${connCount}`); },
    async query(sql, params) { return makeConn('pool').query(sql, params); },
  };
  return { db, pool, hooks };
}

module.exports = { createFakeDb };
