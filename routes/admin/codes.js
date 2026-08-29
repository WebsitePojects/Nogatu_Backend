/**
 * Admin Code Management Routes
 * 1:1 port of PHP adminpanel/generate-codes.php + manage-codes.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { idempotent } = require('../../middleware/idempotency');
const { generateCodes, validateCodeGenerationRequest } = require('../../services/codeGeneration');
const { PRODUCT_TYPES } = require('../../utils/helpers');
const { sanitizeAlphaNum } = require('../../utils/helpers');
const { createProcessKey } = require('../../utils/security');
const { appendActivationCodeUsage } = require('../../services/registrationAudit');
const { listAdminActivationHistory } = require('../../services/codeHistory');
const { findLeadersForMember } = require('../../services/leaders');
const {
  buildSectionedCsv,
  sendCsv,
} = require('../../services/csvExport');
const { buildCodesWorkbook } = require('../../services/xlsxExport');

async function tableExists(tableName) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
}

function firstRowByCode(rows, codeField = 'code') {
  const map = new Map();
  for (const row of rows || []) {
    const code = row?.[codeField];
    if (code && !map.has(code)) {
      map.set(code, row);
    }
  }
  return map;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Status filter values accepted by the admin list/export. `transferred` is DERIVED
// (codestab has no such column) and deliberately OVERLAPS the codestatus values:
// a code can be Released-and-transferred or Used-and-transferred. It is offered as
// its own filter option, and the row payload carries a separate `transferred` flag,
// so the base status is never replaced by transfer history -- consumption state
// (Used) must stay visible on a money-adjacent screen.
const CODE_STATUS_FILTERS = new Set(['all', 'not_released', 'released', 'used', 'transferred']);
const DEFAULT_CODES_PER_PAGE = 40;
const MAX_CODES_PER_PAGE = 500;
const TRANSFER_EVENT_TYPES = ['transfer', 'admin_transfer'];
// A code that only ever moved admin -> first holder has no separator in its trail.
const TRANSFER_TRAIL_SEPARATOR = '->';

// Which tables can evidence a transfer, probed once per process. tableExists() runs a
// SHOW TABLES, and the status filter is on the request path for both the list and the
// export -- an uncached schema probe per request is exactly the cost pattern that made
// the ranking rebuild slow (see .claude/rules/lessons.md 2026-08-06).
let transferSourcesPromise = null;
function getTransferSources() {
  if (!transferSourcesPromise) {
    transferSourcesPromise = (async () => ({
      legacy: await tableExists('codehistorytab'),
      usage: await tableExists('activation_code_usagetab'),
    }))().catch((err) => {
      transferSourcesPromise = null; // don't cache a failure
      throw err;
    });
  }
  return transferSourcesPromise;
}

class InvalidCodeStatusFilterError extends Error {
  constructor(value) {
    super(`Unknown status filter: ${value}`);
    this.name = 'InvalidCodeStatusFilterError';
  }
}

/**
 * Shared WHERE builder for the code list/count/export. All conditions use the
 * `c.` alias (codestab AS c), so every caller must alias codestab as c.
 * Filters: q (code LIKE; an all-digit q ALSO matches the numeric Code ID
 * exactly), owner (holder username LIKE), dateFrom/dateTo (c.dategen window,
 * inclusive, validated as YYYY-MM-DD to reject junk).
 * Cashier (rights=2) is still capped at codestatus <= 1.
 * status: all | not_released | released | used | transferred. Unknown values are
 * REJECTED, never silently ignored -- an unrecognised filter that fell through to
 * "all" would show an admin more codes than they asked for and look like a match.
 * Async because `transferred` must know which transfer-evidence tables exist.
 */
async function buildCodeFilter(req, adminRight) {
  const conds = [adminRight === 2 ? 'c.codestatus <= 1' : 'c.codestatus <= 2'];
  const params = [];
  const q = (req.query.q || '').trim();
  const owner = (req.query.owner || '').trim();
  const dateFrom = (req.query.dateFrom || '').trim();
  const dateTo = (req.query.dateTo || '').trim();

  if (q) {
    if (/^\d+$/.test(q)) {
      // Digits-only: management searches by the table's "Code ID" number too.
      conds.push('(c.code LIKE ? OR c.id = ?)');
      params.push(`%${q}%`, Number(q));
    } else {
      conds.push('c.code LIKE ?');
      params.push(`%${q}%`);
    }
  }
  if (owner) {
    conds.push('c.uid IN (SELECT uid FROM memberstab WHERE username LIKE ?)');
    params.push(`%${owner}%`);
  }
  if (ISO_DATE.test(dateFrom)) { conds.push('c.dategen >= ?'); params.push(`${dateFrom} 00:00:00`); }
  if (ISO_DATE.test(dateTo)) { conds.push('c.dategen < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  const status = (req.query.status || 'all').trim().toLowerCase();
  if (!CODE_STATUS_FILTERS.has(status)) throw new InvalidCodeStatusFilterError(status);
  if (status === 'not_released') conds.push('c.codestatus = 0');
  else if (status === 'released') conds.push('c.codestatus = 1');
  else if (status === 'used') conds.push('c.codestatus = 2');
  else if (status === 'transferred') {
    // Two independent sources: the legacy codehistorytab and Node-era usage events.
    //
    // codehistorytab is NOT a transfer log -- it holds ONE row per code (PK on `code`)
    // and gets that row when the code is RELEASED. On prod, 15,354 of its 24,647 rows
    // are release-only (`(nogatuadmin)Themaker`, or just `nogatuadmin`) with no second
    // hop. Treating "has a history row" as "was transferred" matched 24,654 of 24,889
    // codes -- 99% -- i.e. a filter that selects everything while looking authoritative.
    // A real hand-off always writes a `->` separator, in BOTH stored trail formats:
    //   (nogatuadmin)Ann050890 -> (Ann050890)Malou05      <- legacy chain
    //   tabsqui->VernieS01                                 <- Node member transfer
    // so the arrow is what distinguishes a transfer from a release. With it the
    // predicate matches 10,520 codes (42%), which reconciles with the 9,293 multi-hop
    // history rows plus codes whose only transfer is a Node-era event.
    //
    // The event side needs no such guard: `release` is its own event_type (2,291 rows),
    // distinct from transfer (4,310) and admin_transfer (2,409).
    //
    // Both are single PK-seek EXISTS probes (codehistorytab's PK is `code`), NOT a
    // correlated subquery carrying a JOIN/OR/CAST -- that shape is what degraded the
    // voucher search (lessons.md 2026-07-22). The LIKE runs on the one row the seek
    // returns, so it is not a scan.
    const sources = await getTransferSources();
    const parts = [];
    if (sources.legacy) {
      parts.push(
        'EXISTS (SELECT 1 FROM codehistorytab h WHERE h.code = c.code'
        + ' AND h.history LIKE ?)'
      );
      params.push(`%${TRANSFER_TRAIL_SEPARATOR}%`);
    }
    if (sources.usage) {
      parts.push(
        'EXISTS (SELECT 1 FROM activation_code_usagetab a WHERE a.code = c.code'
        + ` AND a.event_type IN (${TRANSFER_EVENT_TYPES.map(() => '?').join(', ')}))`
      );
      params.push(...TRANSFER_EVENT_TYPES);
    }
    // Neither table present: fail CLOSED (match nothing) rather than matching everything.
    conds.push(parts.length > 0 ? `(${parts.join(' OR ')})` : '1 = 0');
  }

  return { whereSql: `WHERE ${conds.join(' AND ')}`, params };
}

/**
 * POST /api/admin/codes/generate
 * Generate activation codes
 * Mirrors PHP adminpanel/generate-codes.php
 */
router.post('/generate', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const { noOfCodes, productType, codeType } = req.body;

    if (!noOfCodes || noOfCodes < 1 || noOfCodes > 1000) {
      return res.status(400).json({ error: 'Number of codes must be 1-1000' });
    }

    // productType/codeType were previously passed straight to the generator with no
    // validation at all. Validate at the boundary and fail closed: an unknown product
    // or code type, or CD Slot against anything other than Gold/Platinum, is a 400.
    const validation = validateCodeGenerationRequest(productType, codeType);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const codes = await generateCodes(
      Number(noOfCodes),
      Number(productType),
      Number(codeType),
      1, // stockistId always 1
      {
        adminUsername: req.session.adminid || null,
        actorAdminId: req.session.adminNumericId || null,
      }
    );

    res.json({ success: true, count: codes.length, codes });
  } catch (err) {
    console.error('[Admin Codes] Generate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/codes?page=1&q=keyword
 * List all codes (paginated, 100 per page) with optional code search
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const adminRight = Number(req.session.adminrights || 0);
    const page = Math.max(1, Number(req.query.page) || 1);
    // Management asked for a custom row count instead of the fixed 40/100 toggle.
    // Still bounded: every listed page fans out into 4 enrichment queries with an
    // IN-list of that many codes, and the response is rendered/printed in one go.
    const perPage = Math.min(MAX_CODES_PER_PAGE, Math.max(1, Number(req.query.perPage) || DEFAULT_CODES_PER_PAGE));
    const offset = (page - 1) * perPage;

    // Cashier (rights=2) capped at codestatus <= 1; shared filter adds the
    // optional q / owner / dateFrom / dateTo conditions.
    const { whereSql, params: whereParams } = await buildCodeFilter(req, adminRight);

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM codestab c ${whereSql}`,
      whereParams
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT c.id, c.code, c.producttype, c.uid, c.codestatus, c.releasedate, c.processid,
              DATE_FORMAT(c.dategen, '%Y-%m-%d %H:%i') AS dategen,
              m.username AS owner_username,
              TRIM(CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,''))) AS owner_fullname,
              ga.username AS generated_by_username,
              ga.name AS generated_by_name
       FROM codestab c
       LEFT JOIN memberstab m ON m.uid = c.uid
       LEFT JOIN accesstab ga ON ga.username = c.processid
       ${whereSql}
       ORDER BY c.id DESC LIMIT ?, ?`,
      [...whereParams, offset, perPage]
    );

    const pageCodes = rows.map((row) => row.code).filter(Boolean);
    const codePlaceholders = pageCodes.map(() => '?').join(', ');
    let legacyHistoryByCode = new Map();
    let latestReleaseByCode = new Map();
    let latestTransferByCode = new Map();
    let latestRegistrationByCode = new Map();

    if (pageCodes.length > 0) {
      const [legacyHistoryRows] = await pool.query(
        `SELECT code, history, DATE_FORMAT(datetransfer, '%Y-%m-%d %H:%i') AS datetransfer
         FROM codehistorytab
         WHERE code IN (${codePlaceholders})
         ORDER BY datetransfer DESC, id DESC`,
        pageCodes
      );
      legacyHistoryByCode = firstRowByCode(legacyHistoryRows);

      if (await tableExists('activation_code_usagetab')) {
        const [releaseRows] = await pool.query(
          `SELECT a.code,
                  DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
                  aa.username AS admin_username
           FROM activation_code_usagetab a
           LEFT JOIN accesstab aa ON aa.id = a.actor_admin_id
           WHERE a.event_type = 'release'
             AND a.code IN (${codePlaceholders})
           ORDER BY a.id DESC`,
          pageCodes
        );
        latestReleaseByCode = firstRowByCode(releaseRows);

        const [transferRows] = await pool.query(
          `SELECT a.code,
                  DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
                  aa.username AS admin_username,
                  fm.username AS from_username,
                  tm.username AS to_username
           FROM activation_code_usagetab a
           LEFT JOIN accesstab aa ON aa.id = a.actor_admin_id
           LEFT JOIN memberstab fm ON fm.uid = a.from_uid
           LEFT JOIN memberstab tm ON tm.uid = a.to_uid
           WHERE a.event_type IN ('transfer', 'admin_transfer')
             AND a.code IN (${codePlaceholders})
           ORDER BY a.id DESC`,
          pageCodes
        );
        latestTransferByCode = firstRowByCode(transferRows);

        // True OWNER of a USED code = the registrant (registration_uid / to_uid),
        // NOT codestab.uid — registration sets codestatus=2 but never updates uid,
        // so c.uid stays the last transfer-holder. Resolve the real registrant here.
        const [registrationRows] = await pool.query(
          `SELECT a.code,
                  rm.username AS registrant_username,
                  TRIM(CONCAT(COALESCE(rm.firstname,''), ' ', COALESCE(rm.lastname,''))) AS registrant_fullname
           FROM activation_code_usagetab a
           LEFT JOIN memberstab rm ON rm.uid = COALESCE(a.registration_uid, a.to_uid)
           WHERE a.event_type = 'registration_use'
             AND a.code IN (${codePlaceholders})
           ORDER BY a.id DESC`,
          pageCodes
        );
        latestRegistrationByCode = firstRowByCode(registrationRows);
      }
    }

    const codes = rows.map(r => {
      const legacyHistory = legacyHistoryByCode.get(r.code) || null;
      const releaseAudit = latestReleaseByCode.get(r.code) || null;
      const transferAudit = latestTransferByCode.get(r.code) || null;
      const registrationAudit = latestRegistrationByCode.get(r.code) || null;
      const generatedByUsername = r.generated_by_username || r.processid || null;
      const generatedByName = r.generated_by_name || null;
      // Prefer the registrant (who consumed the code) over codestab.uid (last holder).
      const ownerUsername = registrationAudit?.registrant_username || r.owner_username || null;
      const ownerFullname = (registrationAudit?.registrant_fullname || '').trim()
        || (r.owner_fullname ? r.owner_fullname.trim() : '') || null;
      const currentOwnerUsername = ownerUsername || transferAudit?.to_username || generatedByUsername || null;
      const currentOwnerFullname = ownerFullname
        || (!ownerUsername && generatedByName ? generatedByName : null);

      let transferHistory = legacyHistory?.history || null;
      if (!transferHistory && transferAudit?.to_username) {
        const transferActor = transferAudit.admin_username || transferAudit.from_username || 'admin';
        transferHistory = `(${transferActor})${transferAudit.to_username}`;
      }

      return {
        id: r.id,
        code: r.code,
        producttype: r.producttype,
        producttypeName: PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
        uid: r.uid,
        ownerUsername,
        ownerFullname,
        currentOwnerUsername,
        currentOwnerFullname,
        currentOwnerLabel: ownerUsername ? 'Member Owner' : generatedByUsername ? 'Initial Owner / Generator' : null,
        generatedByUsername,
        generatedByName,
        releasedByUsername: releaseAudit?.admin_username || null,
        transferredByUsername: transferAudit?.admin_username || transferAudit?.from_username || null,
        transferredToUsername: transferAudit?.to_username || null,
        transferHistory,
        lastTransferDate: legacyHistory?.datetransfer || transferAudit?.created_at || null,
        lastReleaseDate: releaseAudit?.created_at || null,
        // Derived, and INDEPENDENT of codestatus -- a code can be Used AND transferred.
        // The UI shows this as an extra marker beside the base status, never instead of
        // it, so consumption state is not hidden by transfer history.
        transferred: Boolean(legacyHistory || transferAudit),
        codestatus: r.codestatus,
        statusLabel: r.codestatus === 0 ? 'Not Released' : r.codestatus === 1 ? 'Released' : 'Used',
        releasedate: r.releasedate,
        dategen: r.dategen,
      };
    });

    res.json({ codes, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (err) {
    if (err instanceof InvalidCodeStatusFilterError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[Admin Codes] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/codes/export
 * Export ALL codes matching the current filters (q / owner / dateFrom / dateTo)
 * as an Excel-openable CSV — not just the visible page. Read-only.
 */
router.get('/export', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const adminRight = Number(req.session.adminrights || 0);
    const { whereSql, params } = await buildCodeFilter(req, adminRight);
    const MAX_ROWS = 50000;

    const [rows] = await pool.query(
      `SELECT c.id, c.code, c.producttype, c.codestatus, c.processid,
              DATE_FORMAT(c.dategen, '%Y-%m-%d %H:%i') AS dategen,
              m.username AS owner_username,
              TRIM(CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,''))) AS owner_fullname
       FROM codestab c
       LEFT JOIN memberstab m ON m.uid = c.uid
       ${whereSql}
       ORDER BY c.dategen DESC, c.id DESC
       LIMIT ?`,
      [...params, MAX_ROWS]
    );

    const statusLabel = (s) => (s === 0 ? 'Not Released' : s === 1 ? 'Released' : 'Used');
    const owner = (req.query.owner || '').trim().replace(/[^A-Za-z0-9_-]/g, '') || 'all';
    const filename = `activation-codes-${owner}`;

    // CSV kept as an explicit fallback; default is a real .xlsx with fixed
    // column widths so dates/names don't overlap or show "########" in Excel.
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const csvRows = rows.map((r, i) => ({
        '#': i + 1,
        'Code ID': r.id,
        'Activation Code': r.code,
        'Package': PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
        'Status': statusLabel(r.codestatus),
        'Holder Username': r.owner_username || '',
        'Holder Name': (r.owner_fullname || '').trim(),
        'Generated By': r.processid || '',
        'Date Generated': r.dategen || '',
      }));
      sendCsv(res, filename, buildSectionedCsv([{ rows: csvRows }]));
      return;
    }

    const xlsxRows = rows.map((r, i) => ({
      idx: i + 1,
      codeId: r.id,
      code: r.code,
      pkg: PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
      status: statusLabel(r.codestatus),
      holderUsername: r.owner_username || '',
      holderName: (r.owner_fullname || '').trim(),
      generatedBy: r.processid || '',
      dategen: r.dategen || '',
    }));
    const wb = buildCodesWorkbook(xlsxRows, { sheetName: 'Activation Codes' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err instanceof InvalidCodeStatusFilterError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[Admin Codes] Export error:', err);
    res.status(500).json({ error: 'Failed to export activation codes' });
  }
});

router.get('/history', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = (req.query.q || '').trim();
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));
    const result = await listAdminActivationHistory({ page, perPage, codeQuery: q });
    res.json(result);
  } catch (err) {
    console.error('[Admin Codes] History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history/export', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const history = await listAdminActivationHistory({ page: 1, perPage: 1000, codeQuery: q });
    const csv = buildSectionedCsv([
      {
        title: 'Activation Code History',
        rows: (history.rows || []).map((row) => ({
          Code: row.code,
          Event: row.eventLabel,
          Summary: row.summary,
          'Actor Username': row.actorUsername || '',
          'Actor Admin': row.actorAdminName || '',
          'From Username': row.fromUsername || '',
          'To Username': row.toUsername || '',
          'Created At': row.createdAt || '',
          'Process Key': row.processKey || '',
        })),
      },
    ]);
    sendCsv(res, 'activation-code-history', csv);
  } catch (err) {
    console.error('[Admin Codes] History export error:', err);
    res.status(500).json({ error: 'Failed to export activation code history' });
  }
});

/**
 * GET /api/admin/codes/lookup-account?username=00001
 * Legacy parity helper: search and tag transfer account by username
 */
router.get('/lookup-account', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const username = sanitizeAlphaNum((req.query.username || '').trim());
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const [rows] = await pool.query(
      'SELECT uid, username, firstname, lastname FROM memberstab WHERE username = ? LIMIT 1',
      [username]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const row = rows[0];

    // Nearest named leader above this member in EACH tree. Read-only; a lookup
    // failure must never break the account tag itself, so it degrades to null.
    let leaders = { unilevel: null, binary: null };
    try {
      leaders = await findLeadersForMember(row.uid);
    } catch (leaderErr) {
      console.error('[Admin Codes] Leader lookup failed:', leaderErr.message);
    }

    res.json({
      account: {
        uid: row.uid,
        username: row.username,
        fullname: `${row.firstname} ${row.lastname}`.trim(),
        unilevelLeader: leaders.unilevel,
        binaryLeader: leaders.binary,
      },
    });
  } catch (err) {
    console.error('[Admin Codes] Lookup account error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/codes/release
 * Release codes for distribution
 */
router.post('/release', adminAuth, adminRights([1, 3]), async (req, res) => {
  let conn;
  try {
    const { codes: selectedCodes } = req.body;
    let released = 0;
    conn = await pool.getConnection();
    await conn.beginTransaction();

    for (const code of selectedCodes) {
      const [codeRows] = await conn.query(
        'SELECT id, uid FROM codestab WHERE code = ? AND codestatus = 0 LIMIT 1',
        [code]
      );
      if (codeRows.length === 0) continue;

      const [result] = await conn.query(
        "UPDATE codestab SET releasedate = 1, codestatus = 1 WHERE code = ? AND codestatus = 0 LIMIT 1",
        [code]
      );
      if (result.affectedRows === 1) {
        released++;
        await appendActivationCodeUsage(conn, {
          code,
          codeRowId: codeRows[0].id,
          eventType: 'release',
          toUid: codeRows[0].uid || null,
          actorAdminId: req.session.adminNumericId || null,
          processKey: createProcessKey(['code-release', code, req.session.adminid, Date.now()]),
        });
      }
    }

    await conn.commit();
    res.json({ success: true, released });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Admin Codes] Release error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /api/admin/codes/transfer
 * Transfer codes to member account
 */
router.post('/transfer', adminAuth, adminRights([1, 3]), idempotent('admin.codes.transfer'), async (req, res) => {
  try {
    const adminRight = Number(req.session.adminrights || 0);
    const { targetUsername, codes: selectedCodes } = req.body;

    const targetSanitized = sanitizeAlphaNum(targetUsername);
    const [targetRows] = await pool.query(
      'SELECT uid, username, firstname, lastname FROM memberstab WHERE username = ?',
      [targetSanitized]
    );

    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const targetUid = targetRows[0].uid;
    let transferred = 0;

    for (const code of selectedCodes) {
      const codeWhere = adminRight === 2 ? 'codestatus = 1' : 'codestatus <= 1';
      const [codeRows] = await pool.query(
        `SELECT * FROM codestab WHERE code = ? AND ${codeWhere}`,
        [code]
      );
      if (codeRows.length === 0) continue;

      // Atomic claim: re-assert the same status predicate the SELECT used so a
      // double-submit or concurrent member action can't transfer a consumed code.
      const [transferResult] = await pool.query(
        `UPDATE codestab SET uid = ? WHERE code = ? AND ${codeWhere} LIMIT 1`,
        [targetUid, code]
      );
      if (transferResult.affectedRows !== 1) continue;

      const history = `(${req.session.adminid}).${targetSanitized}`;
      await pool.query(
        `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
         VALUES (?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE history = CONCAT(history, ' -> ', ?), datetransfer = NOW()`,
        [codeRows[0].id, code, codeRows[0].dategen, history, history]
      );

      await appendActivationCodeUsage(pool, {
        code,
        codeRowId: codeRows[0].id,
        eventType: 'admin_transfer',
        fromUid: codeRows[0].uid || null,
        toUid: targetUid,
        actorAdminId: req.session.adminNumericId || null,
        notes: {
          targetUsername: targetSanitized,
        },
        processKey: createProcessKey(['admin-code-transfer', code, req.session.adminid, targetUid, Date.now()]),
      });

      transferred++;
    }

    res.json({ success: true, transferred });
  } catch (err) {
    console.error('[Admin Codes] Transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/release-transfer', adminAuth, adminRights([1, 3]), async (req, res) => {
  let conn;
  try {
    const { targetUsername, codes: selectedCodes } = req.body;
    const targetSanitized = sanitizeAlphaNum(targetUsername);
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [targetRows] = await conn.query(
      'SELECT uid, username, firstname, lastname FROM memberstab WHERE username = ?',
      [targetSanitized]
    );

    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const targetUid = Number(targetRows[0].uid);
    let released = 0;
    let transferred = 0;

    for (const code of selectedCodes || []) {
      const [codeRows] = await conn.query(
        'SELECT * FROM codestab WHERE code = ? AND codestatus <= 1 LIMIT 1',
        [code]
      );
      if (codeRows.length === 0) continue;

      const codeRow = codeRows[0];
      if (Number(codeRow.codestatus || 0) === 0) {
        const [releaseResult] = await conn.query(
          "UPDATE codestab SET releasedate = 1, codestatus = 1 WHERE code = ? AND codestatus = 0 LIMIT 1",
          [code]
        );
        if (releaseResult.affectedRows === 1) {
          released += 1;
          await appendActivationCodeUsage(conn, {
            code,
            codeRowId: codeRow.id,
            eventType: 'release',
            toUid: codeRow.uid || null,
            actorAdminId: req.session.adminNumericId || null,
            processKey: createProcessKey(['code-release', code, req.session.adminid, 'release-transfer', Date.now()]),
          });
        }
      }

      await conn.query(
        'UPDATE codestab SET uid = ? WHERE code = ? AND codestatus = 1 LIMIT 1',
        [targetUid, code]
      );

      const history = `(${req.session.adminid}).${targetSanitized}`;
      await conn.query(
        `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
         VALUES (?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE history = CONCAT(history, ' -> ', ?), datetransfer = NOW()`,
        [codeRow.id, code, codeRow.dategen, history, history]
      );

      await appendActivationCodeUsage(conn, {
        code,
        codeRowId: codeRow.id,
        eventType: 'admin_transfer',
        fromUid: codeRow.uid || null,
        toUid: targetUid,
        actorAdminId: req.session.adminNumericId || null,
        notes: {
          targetUsername: targetSanitized,
          releasedAndTransferred: true,
        },
        processKey: createProcessKey(['admin-code-release-transfer', code, req.session.adminid, targetUid, Date.now()]),
      });

      transferred += 1;
    }

    await conn.commit();
    res.json({ success: true, released, transferred });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Admin Codes] Release+Transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
