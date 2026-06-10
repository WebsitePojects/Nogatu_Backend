/**
 * Admin Code Management Routes
 * 1:1 port of PHP adminpanel/generate-codes.php + manage-codes.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { generateCodes } = require('../../services/codeGeneration');
const { PRODUCT_TYPES } = require('../../utils/helpers');
const { sanitizeAlphaNum } = require('../../utils/helpers');
const { createProcessKey } = require('../../utils/security');
const { appendActivationCodeUsage } = require('../../services/registrationAudit');
const { listAdminActivationHistory } = require('../../services/codeHistory');
const {
  buildSectionedCsv,
  sendCsv,
} = require('../../services/csvExport');

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

    const codes = await generateCodes(
      Number(noOfCodes),
      Number(productType),
      Number(codeType),
      1, // stockistId always 1
      req.session.adminid
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
router.get('/', adminAuth, async (req, res) => {
  try {
    const adminRight = Number(req.session.adminrights || 0);
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 40));
    const offset = (page - 1) * perPage;
    const q = (req.query.q || '').trim();

    // Cashier (rights=2) can manage transfer/release-ready codes only.
    let whereSql = adminRight === 2 ? 'WHERE c.codestatus <= 1' : 'WHERE c.codestatus <= 2';
    let countWhereSql = adminRight === 2 ? 'WHERE codestatus <= 1' : 'WHERE codestatus <= 2';
    const whereParams = [];
    if (q) {
      whereSql += ' AND c.code LIKE ?';
      countWhereSql += ' AND code LIKE ?';
      whereParams.push(`%${q}%`);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM codestab ${countWhereSql}`,
      whereParams
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT c.id, c.code, c.producttype, c.uid, c.codestatus, c.releasedate,
              DATE_FORMAT(c.dategen, '%Y-%m-%d %H:%i') AS dategen,
              m.username AS owner_username,
              TRIM(CONCAT(COALESCE(m.firstname,''), ' ', COALESCE(m.lastname,''))) AS owner_fullname,
              ch.history AS transfer_history,
              DATE_FORMAT(ch.datetransfer, '%Y-%m-%d %H:%i') AS last_transfer_date,
              lat.to_username AS audit_transfer_to,
              DATE_FORMAT(lat.created_at, '%Y-%m-%d %H:%i') AS audit_transfer_date,
              lat.admin_name AS audit_admin_name
       FROM codestab c
       LEFT JOIN memberstab m ON m.uid = c.uid
       LEFT JOIN codehistorytab ch ON ch.code = c.code
       LEFT JOIN (
         SELECT a.code, a.to_uid, a.created_at, tm.username AS to_username, aa.username AS admin_name
         FROM activation_code_usagetab a
         LEFT JOIN memberstab tm ON tm.uid = a.to_uid
         LEFT JOIN accesstab aa ON aa.id = a.actor_admin_id
         WHERE a.event_type = 'admin_transfer'
           AND a.id = (
             SELECT MAX(a2.id) FROM activation_code_usagetab a2
             WHERE a2.code = a.code AND a2.event_type = 'admin_transfer'
           )
       ) lat ON lat.code = c.code
       ${whereSql}
       ORDER BY c.id DESC LIMIT ?, ?`,
      [...whereParams, offset, perPage]
    );

    const codes = rows.map(r => {
      const legacyHistory = r.transfer_history || null;
      const auditTo = r.audit_transfer_to || null;
      const auditAdmin = r.audit_admin_name || null;
      // Build a display-ready transfer trail from whichever source has data
      let transferHistory = legacyHistory;
      if (!transferHistory && auditTo) {
        transferHistory = auditAdmin
          ? `(${auditAdmin})${auditTo}`
          : `(admin)${auditTo}`;
      }
      return {
        id: r.id,
        code: r.code,
        producttype: r.producttype,
        producttypeName: PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
        uid: r.uid,
        ownerUsername: r.owner_username || null,
        ownerFullname: r.owner_fullname ? r.owner_fullname.trim() || null : null,
        transferHistory,
        lastTransferDate: r.last_transfer_date || r.audit_transfer_date || null,
        codestatus: r.codestatus,
        statusLabel: r.codestatus === 0 ? 'Not Released' : r.codestatus === 1 ? 'Released' : 'Used',
        releasedate: r.releasedate,
        dategen: r.dategen,
      };
    });

    res.json({ codes, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[Admin Codes] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
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

router.get('/history/export', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
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
router.get('/lookup-account', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
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
    res.json({
      account: {
        uid: row.uid,
        username: row.username,
        fullname: `${row.firstname} ${row.lastname}`.trim(),
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
router.post('/release', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    const { codes: selectedCodes } = req.body;
    let released = 0;

    for (const code of selectedCodes) {
      const [codeRows] = await pool.query(
        'SELECT id, uid FROM codestab WHERE code = ? AND codestatus = 0 LIMIT 1',
        [code]
      );
      if (codeRows.length === 0) continue;

      const [result] = await pool.query(
        "UPDATE codestab SET releasedate = 1, codestatus = 1 WHERE code = ? AND codestatus = 0 LIMIT 1",
        [code]
      );
      if (result.affectedRows === 1) {
        released++;
        await appendActivationCodeUsage(pool, {
          code,
          codeRowId: codeRows[0].id,
          eventType: 'release',
          toUid: codeRows[0].uid || null,
          actorAdminId: req.session.adminNumericId || null,
          processKey: createProcessKey(['code-release', code, req.session.adminid, Date.now()]),
        });
      }
    }

    res.json({ success: true, released });
  } catch (err) {
    console.error('[Admin Codes] Release error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/codes/transfer
 * Transfer codes to member account
 */
router.post('/transfer', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
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

      await pool.query(
        'UPDATE codestab SET uid = ? WHERE code = ? LIMIT 1',
        [targetUid, code]
      );

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

router.post('/release-transfer', adminAuth, adminRights([1, 2, 3]), async (req, res) => {
  try {
    const { targetUsername, codes: selectedCodes } = req.body;
    const targetSanitized = sanitizeAlphaNum(targetUsername);
    const [targetRows] = await pool.query(
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
      const [codeRows] = await pool.query(
        'SELECT * FROM codestab WHERE code = ? AND codestatus <= 1 LIMIT 1',
        [code]
      );
      if (codeRows.length === 0) continue;

      const codeRow = codeRows[0];
      if (Number(codeRow.codestatus || 0) === 0) {
        const [releaseResult] = await pool.query(
          "UPDATE codestab SET releasedate = 1, codestatus = 1 WHERE code = ? AND codestatus = 0 LIMIT 1",
          [code]
        );
        if (releaseResult.affectedRows === 1) {
          released += 1;
          await appendActivationCodeUsage(pool, {
            code,
            codeRowId: codeRow.id,
            eventType: 'release',
            toUid: codeRow.uid || null,
            actorAdminId: req.session.adminNumericId || null,
            processKey: createProcessKey(['code-release', code, req.session.adminid, 'release-transfer', Date.now()]),
          });
        }
      }

      await pool.query(
        'UPDATE codestab SET uid = ? WHERE code = ? AND codestatus = 1 LIMIT 1',
        [targetUid, code]
      );

      const history = `(${req.session.adminid}).${targetSanitized}`;
      await pool.query(
        `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
         VALUES (?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE history = CONCAT(history, ' -> ', ?), datetransfer = NOW()`,
        [codeRow.id, code, codeRow.dategen, history, history]
      );

      await appendActivationCodeUsage(pool, {
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

    res.json({ success: true, released, transferred });
  } catch (err) {
    console.error('[Admin Codes] Release+Transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
