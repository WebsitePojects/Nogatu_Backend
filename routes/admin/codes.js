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
 * GET /api/admin/codes?page=1
 * List all codes (paginated, 100 per page)
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 100;
    const offset = (page - 1) * perPage;

    const [countRows] = await pool.query(
      'SELECT COUNT(*) as total FROM codestab WHERE codestatus <= 2'
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.query(
      `SELECT id, code, producttype, uid, codestatus, releasedate,
              DATE_FORMAT(dategen, '%Y-%m-%d %H:%i') as dategen
       FROM codestab WHERE codestatus <= 2
       ORDER BY id DESC LIMIT ?, ?`,
      [offset, perPage]
    );

    const codes = rows.map(r => ({
      id: r.id,
      code: r.code,
      producttype: r.producttype,
      producttypeName: PRODUCT_TYPES[r.producttype] || `Type ${r.producttype}`,
      uid: r.uid,
      codestatus: r.codestatus,
      statusLabel: r.codestatus === 0 ? 'Not Released' : r.codestatus === 1 ? 'Released' : 'Used',
      releasedate: r.releasedate,
      dategen: r.dategen,
    }));

    res.json({ codes, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[Admin Codes] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/codes/release
 * Release codes for distribution
 */
router.post('/release', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const { codes: selectedCodes } = req.body;
    let released = 0;

    for (const code of selectedCodes) {
      const [result] = await pool.query(
        "UPDATE codestab SET releasedate = 1, codestatus = 1 WHERE code = ? AND codestatus = 0 LIMIT 1",
        [code]
      );
      if (result.affectedRows === 1) released++;
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
router.post('/transfer', adminAuth, async (req, res) => {
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

    const targetUid = targetRows[0].uid;
    let transferred = 0;

    for (const code of selectedCodes) {
      const [codeRows] = await pool.query(
        'SELECT * FROM codestab WHERE code = ? AND codestatus <= 1',
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

      transferred++;
    }

    res.json({ success: true, transferred });
  } catch (err) {
    console.error('[Admin Codes] Transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
