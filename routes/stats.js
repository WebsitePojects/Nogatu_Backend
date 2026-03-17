const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET /api/stats - Public: Get aggregate stats for landing page
router.get('/', async (req, res) => {
  try {
    const [[memberRow]] = await pool.query(
      "SELECT COUNT(*) AS total FROM usertab WHERE codeid IS NOT NULL AND codeid != ''"
    );
    const [[networkRow]] = await pool.query(
      "SELECT COUNT(DISTINCT mainid) AS total FROM usertab WHERE mainid IS NOT NULL AND mainid != ''"
    );
    res.json({
      activeMembers: memberRow?.total || 0,
      networksBuilt: networkRow?.total || 0,
    });
  } catch (err) {
    console.error('[Stats] GET error:', err.message);
    res.json({ activeMembers: 0, networksBuilt: 0 });
  }
});

module.exports = router;
