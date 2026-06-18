/**
 * Admin read-only "view as member" — resolve endpoint.
 *
 * Returns the minimum identity the admin portal needs to START a read-only view-as
 * session (the target uid + display name). The actual data access happens through the
 * normal member GET endpoints with the X-View-As-Member header, enforced read-only in
 * middleware/auth.js (memberAuth). Admin-authenticated; read-only.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

router.get('/resolve', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    const idParam = Number(req.query.uid || 0);
    if (!username && !idParam) {
      return res.status(400).json({ error: 'username or uid required' });
    }
    const [rows] = await pool.query(
      `SELECT u.uid, m.username, m.firstname, m.lastname, u.currentaccttype
         FROM usertab u
         INNER JOIN memberstab m ON m.uid = u.uid
        WHERE u.uid = u.mainid AND ${idParam ? 'u.uid = ?' : 'm.username = ?'}
        LIMIT 1`,
      [idParam ? idParam : username]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const r = rows[0];
    res.json({
      uid: Number(r.uid),
      username: r.username,
      fullName: `${r.firstname || ''} ${r.lastname || ''}`.trim() || r.username,
      accttype: Number(r.currentaccttype || 0),
    });
  } catch (error) {
    console.error('[Admin ViewAs] resolve error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
