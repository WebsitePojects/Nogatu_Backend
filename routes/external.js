const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Cross-system bridge for NCDMS (nogatu.store dropshipping). NCDMS users are all
// stockists; stockists earn their own Portions in the global bonus, so the MLM
// must know which members are stockists. Guarded by a shared secret.
function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!process.env.EXTERNAL_API_KEY || key !== process.env.EXTERNAL_API_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  }
  return next();
}

const PACKAGE_LABELS = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };

router.use(requireApiKey);

// GET /api/external/member/:username
// NCDMS verifies a member and reads their package + stockist flag (for member discount).
router.get('/member/:username', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.username, m.uid, u.currentaccttype AS package_code, u.account_status, u.stockist
       FROM memberstab m JOIN usertab u ON u.uid = m.uid
       WHERE m.username = ? LIMIT 1`,
      [req.params.username]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Member not found' });
    const r = rows[0];
    return res.json({
      success: true,
      data: {
        username: r.username,
        uid: r.uid,
        package_code: r.package_code,
        package_label: PACKAGE_LABELS[r.package_code] || null,
        account_status: r.account_status,
        is_stockist: !!r.stockist,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/external/stockists/sync
// NCDMS pushes its stockist usernames so the MLM flags those members.
// body: { usernames: string[], reset?: boolean }
router.post('/stockists/sync', async (req, res) => {
  const usernames = Array.isArray(req.body && req.body.usernames)
    ? req.body.usernames.filter(Boolean)
    : [];
  const reset = req.body && req.body.reset === true;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (reset) {
      await conn.query('UPDATE usertab SET stockist = 0 WHERE stockist = 1');
    }
    let flagged = 0;
    if (usernames.length) {
      const [result] = await conn.query(
        `UPDATE usertab u JOIN memberstab m ON m.uid = u.uid
         SET u.stockist = 1
         WHERE m.username IN (?)`,
        [usernames]
      );
      flagged = result.affectedRows;
    }
    await conn.commit();
    return res.json({ success: true, data: { flagged, reset } });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
