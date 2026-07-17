/**
 * Activation Codes Routes (Member)
 * 1:1 port of PHP myactivation-codes.php + upgrade-account.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { idempotent } = require('../middleware/idempotency');
const { sanitizeAlphaNum, nowMySQL, PRODUCT_TYPES, ACCOUNT_TYPES, CODE_PREFIXES, currentMonthRange } = require('../utils/helpers');
const { createProcessKey, createPublicId } = require('../utils/security');
const { appendActivationCodeUsage } = require('../services/registrationAudit');
const { listMemberActivationHistory } = require('../services/codeHistory');
const { refreshMemberRankSnapshot } = require('../services/ranking');
const { applyRepurchaseDelta } = require('../services/rankPoints');
const { getTotalPointsForRange } = require('../services/income/unilevel');

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
      `SELECT id, code, producttype, codetype, productamount, uid, codestatus, releasedate, dategen
       FROM codestab WHERE codestatus <= 2 AND uid = ?
       ORDER BY id DESC LIMIT ?, ?`,
      [uid, offset, perPage]
    );

    const formatted = codes.map(c => {
      const isMaintenance = Number(c.producttype || 0) >= 100;
      // PHP stores codetype = producttype for maintenance codes (not 1/2/3).
      // Treat any codetype outside 1-3 on a maintenance code as 'MC'.
      const rawCodetype = Number(c.codetype || 0);
      const resolvedCodetype = isMaintenance ? 0 : rawCodetype;
      const codeTypeLabel = isMaintenance ? 'MC' : (CODE_PREFIXES[rawCodetype] || 'Unknown');
      const productName = PRODUCT_TYPES[c.producttype] || `Type ${c.producttype}`;
      const accountLabel = isMaintenance
        ? `${productName} — Repurchase`
        : `${ACCOUNT_TYPES[c.producttype] || productName} - ${CODE_PREFIXES[rawCodetype] || 'Unknown'}`;
      return {
        id: c.id,
        code: c.code,
        producttype: c.producttype,
        codetype: resolvedCodetype,
        codeTypeLabel,
        producttypeName: productName,
        accountLabel,
        productamount: Number(c.productamount || 0),
        codestatus: c.codestatus,
        statusLabel: c.codestatus === 0 ? 'For Release' : c.codestatus === 1 ? 'Available' : 'Used',
        dategen: c.dategen,
      };
    });

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

router.get('/history', memberAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const result = await listMemberActivationHistory(req.session.uid, page, 20);
    res.json(result);
  } catch (err) {
    console.error('[Codes] History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/codes/resolve-member?username=X
 * Resolve a target username to a member full name so the transfer/activation
 * confirmation can show WHO the code goes to (prevents activating for the wrong person).
 */
router.get('/resolve-member', memberAuth, async (req, res) => {
  try {
    const username = sanitizeAlphaNum(req.query.username || '');
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const [rows] = await pool.query(
      'SELECT username, firstname, lastname FROM memberstab WHERE username = ? LIMIT 1',
      [username]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const r = rows[0];
    res.json({
      username: r.username,
      fullName: `${r.firstname || ''} ${r.lastname || ''}`.trim() || r.username,
    });
  } catch (err) {
    console.error('[Codes] resolve-member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/codes/transfer
 * Transfer codes to another member
 */
router.post('/transfer', memberAuth, idempotent('codes.transfer'), async (req, res) => {
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

      // Transfer code — atomic claim: only moves if still owned by sender and unused,
      // so a double-tap or a concurrent use/transfer of the same code can't win twice.
      const [transferResult] = await pool.query(
        'UPDATE codestab SET uid = ? WHERE code = ? AND uid = ? AND codestatus = 1 LIMIT 1',
        [targetUid, code, uid]
      );
      if (transferResult.affectedRows !== 1) continue;

      // Log to codehistorytab
      const history = `${req.session.username}->${targetSanitized}`;
      await pool.query(
        `INSERT INTO codehistorytab (id, code, dategen, history, datetransfer, processid)
         VALUES (?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE history = CONCAT(history, ' -> ', ?), datetransfer = NOW()`,
        [codeRows[0].id, code, codeRows[0].dategen, history, history]
      );

      await appendActivationCodeUsage(pool, {
        code,
        codeRowId: codeRows[0].id,
        eventType: 'transfer',
        fromUid: uid,
        toUid: targetUid,
        actorUid: uid,
        notes: {
          targetUsername: targetSanitized,
        },
        processKey: createProcessKey(['member-code-transfer', code, uid, targetUid, Date.now()]),
      });

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
router.post('/upgrade', memberAuth, idempotent('codes.upgrade'), async (req, res) => {
  let conn;
  try {
    const uid = req.session.uid;
    const code = sanitizeAlphaNum(req.body?.code || '');

    if (!code) {
      return res.status(400).json({ error: 'Upgrade code is required' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [memberRows] = await conn.query(
      `SELECT accttype, currentaccttype, codeid, cdamount, cdtotal, cdstatus
         FROM usertab
        WHERE uid = ?
        LIMIT 1
        FOR UPDATE`,
      [uid]
    );

    if (memberRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Account not found' });
    }

    const member = memberRows[0];

    // Validate upgrade code
    const [codeRows] = await conn.query(
      `SELECT * FROM codestab WHERE code = ? AND producttype > ?
       AND codetype IN (1, 2, 3) AND producttype <= 90 AND codestatus = 1 AND uid = ?`,
      [code, member.currentaccttype, uid]
    );

    if (codeRows.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid upgrade code' });
    }

    const codeData = codeRows[0];

    // Update code status
    const [useResult] = await conn.query(
      "UPDATE codestab SET dateused = NOW(), codestatus = 2, uid = ? WHERE code = ? AND uid = ? AND codestatus = 1 LIMIT 1",
      [uid, code, uid]
    );
    if (useResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Upgrade code is no longer available' });
    }

    // Update account state based on the actual code type used for the upgrade.
    if (Number(codeData.codetype) === 1) {
      await conn.query(
        `UPDATE usertab
            SET currentaccttype = ?,
                codeid = 1,
                cdamount = 0,
                cdtotal = 0,
                cdstatus = 0
          WHERE uid = ?
          LIMIT 1`,
        [codeData.producttype, uid]
      );
    } else if (Number(codeData.codetype) === 2) {
      await conn.query(
        `UPDATE usertab
            SET currentaccttype = ?,
                codeid = 2,
                cdamount = 0,
                cdtotal = 0,
                cdstatus = 0
          WHERE uid = ?
          LIMIT 1`,
        [codeData.producttype, uid]
      );
    } else if (Number(codeData.codetype) === 3) {
      await conn.query(
        `UPDATE usertab
            SET currentaccttype = ?,
                codeid = 3,
                cdamount = ?,
                cdtotal = 0,
                cdstatus = 1
          WHERE uid = ?
          LIMIT 1`,
        [codeData.producttype, codeData.productamount, uid]
      );
    } else {
      await conn.query(
        'UPDATE usertab SET currentaccttype = ? WHERE uid = ? LIMIT 1',
        [codeData.producttype, uid]
      );
    }

    // Insert upgrade record
    const now = nowMySQL();
    await conn.query(
      `INSERT INTO upgradetab (id, uid, producttype, transtype, codeid,
       binarypoints, incentivepoints, processid, transdate)
       VALUES (NULL, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [uid, codeData.producttype, codeData.id, codeData.binarypoints,
       codeData.directreferral, String(uid), now]
    );

    await conn.query(
      `INSERT INTO binary_point_eventstab
       (event_uid, source_member_uid, owner_uid, parent_uid, leg, event_type,
        package_type, point_value, reference_key, event_ts)
       SELECT ?, u.uid, u.drefid, u.refid,
              CASE WHEN u.position = 1 THEN 'left' ELSE 'right' END,
              'package_upgrade', ?, ?, ?, ?
         FROM usertab u
        WHERE u.uid = ?
        LIMIT 1
       ON DUPLICATE KEY UPDATE event_uid = event_uid`,
      [
        createPublicId(),
        String(codeData.producttype || ''),
        Number(codeData.binarypoints || 0),
        createProcessKey(['binary-point-event', 'upgrade-code', code, uid, now]),
        now,
        uid,
      ]
    ).catch((error) => {
      if (error.code === 'ER_NO_SUCH_TABLE') return;
      throw error;
    });

    await appendActivationCodeUsage(conn, {
      code,
      codeRowId: codeData.id,
      eventType: 'upgrade_use',
      fromUid: uid,
      toUid: uid,
      actorUid: uid,
      upgradeUid: uid,
      notes: {
        newProductType: Number(codeData.producttype),
        codeType: Number(codeData.codetype),
      },
      processKey: createProcessKey(['code-upgrade-use', code, uid, codeData.producttype, now]),
    });

    await conn.commit();

    // Rebuild ranking snapshot in background — do not block the response
    setImmediate(() => {
      refreshMemberRankSnapshot(uid).catch(err =>
        console.error('[Ranking] post-upgrade rebuild failed:', err)
      );
    });

    // Update session
    req.session.currentaccttype = codeData.producttype;
    req.session.caccttype = ACCOUNT_TYPES[codeData.producttype] || 'Unknown';
    if (Number(codeData.codetype) === 2 || Number(codeData.codetype) === 1) {
      req.session.cdstatus = 0;
    } else if (Number(codeData.codetype) === 3) {
      req.session.cdstatus = 1;
    }

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
router.post('/maintenance', memberAuth, idempotent('codes.maintenance'), async (req, res) => {
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

    // Maintenance bucket split: transType 1 -> 'unilevel' (counts toward the monthly
    // 200 unilevel maintenance + unilevel income); transType 2 -> 'hifive' (counts only
    // toward the 5-directs-same-product free claim, never toward unilevel).
    const maintenanceBucket = transType === 2 ? 'hifive' : 'unilevel';

    // Gate: Hi-Five only unlocks AFTER the member reaches 200 unilevel maintenance points
    // THIS month. Until then only unilevel maintenance is allowed (enforced server-side so
    // the threshold can't be bypassed by sending transType=2 directly).
    if (transType === 2) {
      const { start, end } = currentMonthRange();
      const unilevelPts = await getTotalPointsForRange(uid, start, end, 'unilevel');
      if (unilevelPts < 200) {
        return res.status(400).json({
          error: 'Hi-Five unlocks after you reach 200 unilevel maintenance points this month.',
          code: 'HIFIVE_LOCKED',
          unilevelPoints: unilevelPts,
        });
      }
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
      "UPDATE codestab SET dateused = NOW(), codestatus = 2 WHERE code = ? AND uid = ? AND codestatus = 1 LIMIT 1",
      [code, uid]
    );
    if (useResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Maintenance code is no longer available' });
    }

    // Insert repurchase record (tagged to the chosen maintenance bucket).
    await conn.query(
      `INSERT INTO repurchasetab (id, uid, producttype, maintenance_bucket, code, transtype, codeid,
       incentivepoints1, transdate)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [uid, codeData.producttype, maintenanceBucket, code, transType, codeData.codetype, codeData.unilevelpoints]
    );

    await appendActivationCodeUsage(conn, {
      code,
      codeRowId: codeData.id,
      eventType: 'maintenance_use',
      fromUid: uid,
      toUid: uid,
      actorUid: uid,
      notes: {
        transType,
        productType: Number(codeData.producttype),
      },
      processKey: createProcessKey(['code-maintenance-use', code, uid, transType, nowMySQL()]),
    });

    await conn.commit();

    // Rebuild ranking snapshot in background — do not block the response
    setImmediate(() => {
      refreshMemberRankSnapshot(uid).catch(err =>
        console.error('[Ranking] post-maintenance rebuild failed:', err)
      );
      // Phase-1 SHADOW: incrementally propagate this repurchase up the sponsor
      // chain (O(depth)). Does NOT drive the live leaderboard yet — reconciled first.
      applyRepurchaseDelta(null, uid, Number(codeData.unilevelpoints || 0)).catch(err =>
        console.error('[RankPoints] shadow propagate failed:', err.message)
      );
    });

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
