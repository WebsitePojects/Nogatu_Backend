/**
 * Activation Codes Routes (Member)
 * 1:1 port of PHP myactivation-codes.php + upgrade-account.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { sanitizeAlphaNum, nowMySQL, PRODUCT_TYPES, ACCOUNT_TYPES } = require('../utils/helpers');

/**
 * GET /api/codes?page=1
 * Get member's activation codes (paginated, 30 per page)
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;

    const [countRows] = await pool.query(
      'SELECT COUNT(*) as total FROM codestab WHERE codestatus <= 2 AND uid = ?',
      [uid]
    );
    const total = Number(countRows[0].total);

    const [codes] = await pool.query(
      `SELECT id, code, producttype, uid, codestatus, releasedate, dategen
       FROM codestab WHERE codestatus <= 2 AND uid = ?
       ORDER BY id DESC LIMIT ?, ?`,
      [uid, offset, perPage]
    );

    const formatted = codes.map(c => ({
      id: c.id,
      code: c.code,
      producttype: c.producttype,
      producttypeName: PRODUCT_TYPES[c.producttype] || `Type ${c.producttype}`,
      codestatus: c.codestatus,
      statusLabel: c.codestatus === 0 ? 'For Release' : c.codestatus === 1 ? 'Available' : 'Used',
      dategen: c.dategen,
    }));

    res.json({
      codes: formatted,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (err) {
    console.error('[Codes] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/codes/transfer
 * Transfer codes to another member
 */
router.post('/transfer', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const { targetUsername, codes: selectedCodes } = req.body;

    if (!targetUsername || !selectedCodes || selectedCodes.length === 0) {
      return res.status(400).json({ error: 'Target username and codes are required' });
    }

    // Get target account
    const targetSanitized = sanitizeAlphaNum(targetUsername);
    const [targetRows] = await pool.query(
      'SELECT uid, username, firstname, lastname FROM memberstab WHERE username = ?',
      [targetSanitized]
    );
    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const targetUid = targetRows[0].uid;
    const targetName = `${targetRows[0].firstname} ${targetRows[0].lastname}`;
    let transferred = 0;

    for (const code of selectedCodes) {
      // Verify code belongs to current user and is transferable
      const [codeRows] = await pool.query(
        'SELECT * FROM codestab WHERE code = ? AND uid = ? AND codestatus = 1',
        [code, uid]
      );
      if (codeRows.length === 0) continue;

      // Transfer code
      await pool.query(
        'UPDATE codestab SET uid = ? WHERE code = ? LIMIT 1',
        [targetUid, code]
      );

      // Log to codehistorytab
      const history = `${req.session.username}->${targetSanitized}`;
      await pool.query(
        `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
         VALUES (?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE history = CONCAT(history, ' -> ', ?), datetransfer = NOW()`,
        [codeRows[0].id, code, codeRows[0].dategen, history, history]
      );

      transferred++;
    }

    res.json({ success: true, transferred, targetName });
  } catch (err) {
    console.error('[Codes] Transfer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/codes/upgrade
 * Upgrade account using activation code
 */
router.post('/upgrade', memberAuth, async (req, res) => {
  let conn;
  try {
    const uid = req.session.uid;
    const code = sanitizeAlphaNum(req.body?.code || '');

    if (!code) {
      return res.status(400).json({ error: 'Upgrade code is required' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validate upgrade code
    const [codeRows] = await conn.query(
      `SELECT * FROM codestab WHERE code = ? AND producttype > ?
       AND codetype = 1 AND producttype <= 90 AND codestatus = 1 AND uid = ?`,
      [code, req.session.currentaccttype, uid]
    );

    if (codeRows.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid upgrade code' });
    }

    const codeData = codeRows[0];

    // Update code status
    const [useResult] = await conn.query(
      "UPDATE codestab SET dateused = NOW(), codestatus = 2, uid = ? WHERE code = ? LIMIT 1",
      [uid, code]
    );
    if (useResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Upgrade code is no longer available' });
    }

    // Update account type
    await conn.query(
      'UPDATE usertab SET currentaccttype = ? WHERE uid = ? LIMIT 1',
      [codeData.producttype, uid]
    );

    // Insert upgrade record
    const now = nowMySQL();
    await conn.query(
      `INSERT INTO upgradetab (id, uid, producttype, transtype, codeid,
       binarypoints, incentivepoints, processid, transdate)
       VALUES (NULL, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [uid, codeData.producttype, codeData.id, codeData.binarypoints,
       codeData.directreferral, String(uid), now]
    );

    await conn.commit();

    // Update session
    req.session.currentaccttype = codeData.producttype;
    req.session.caccttype = ACCOUNT_TYPES[codeData.producttype] || 'Unknown';

    res.json({
      success: true,
      newAccountType: codeData.producttype,
      newAccountTypeName: ACCOUNT_TYPES[codeData.producttype],
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Codes] Upgrade error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /api/codes/maintenance
 * Activate maintenance code (repurchase)
 */
router.post('/maintenance', memberAuth, async (req, res) => {
  let conn;
  try {
    const uid = req.session.uid;
    const code = sanitizeAlphaNum(req.body?.code || '');
    const transType = Number(req.body?.transType || 1); // 1 = Maintenance, 2 = Hi-Five

    if (!code) {
      return res.status(400).json({ error: 'Maintenance code is required' });
    }

    if (transType !== 1 && transType !== 2) {
      return res.status(400).json({ error: 'Invalid maintenance transaction type' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validate maintenance code
    const [codeRows] = await conn.query(
      'SELECT * FROM codestab WHERE code = ? AND codestatus = 1 AND producttype >= 100 AND uid = ?',
      [code, uid]
    );

    if (codeRows.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid maintenance code' });
    }

    const codeData = codeRows[0];

    // Update code status to used
    const [useResult] = await conn.query(
      "UPDATE codestab SET dateused = NOW(), codestatus = 2 WHERE code = ? AND uid = ? LIMIT 1",
      [code, uid]
    );
    if (useResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Maintenance code is no longer available' });
    }

    // Insert repurchase record
    await conn.query(
      `INSERT INTO repurchasetab (id, uid, producttype, code, transtype, codeid,
       incentivepoints1, transdate)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, NOW())`,
      [uid, codeData.producttype, code, transType, codeData.codetype, codeData.unilevelpoints]
    );

    await conn.commit();

    res.json({ success: true, producttype: codeData.producttype });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('[Codes] Maintenance error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
