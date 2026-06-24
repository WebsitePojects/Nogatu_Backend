const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { ensureApplicationsTable } = require('../applications');

const FOLLOW_UP_STATUSES = new Set(['new', 'followed_up', 'cancelled', 'done']);

function normalizeStatus(raw) {
  const status = String(raw || 'all').toLowerCase();
  return FOLLOW_UP_STATUSES.has(status) ? status : 'all';
}

async function updateFollowUpStatus(req, res, followUpStatus) {
  try {
    await ensureApplicationsTable();

    const id = Number(req.params.id);
    const note = String(req.body?.note || '').trim();

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid application reference.' });
    }

    if (note.length > 8000) {
      return res.status(400).json({ error: 'Admin note is too long.' });
    }

    const [result] = await pool.query(
      `UPDATE distributor_applicationstab
       SET follow_up_status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = NOW()
       WHERE id = ? LIMIT 1`,
      [followUpStatus, note || null, req.session.adminid || null, id]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    res.json({ success: true, followUpStatus });
  } catch (err) {
    console.error(`[Admin Applications] ${followUpStatus} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureApplicationsTable();

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
    const offset = (page - 1) * perPage;
    const status = normalizeStatus(req.query.status);

    const params = [];
    let whereSql = '';
    if (status !== 'all') {
      whereSql = 'WHERE follow_up_status = ?';
      params.push(status);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM distributor_applicationstab ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT id, name, sponsor_name, age, phone, email,
              status, follow_up_status, admin_note, reviewed_by,
              DATE_FORMAT(reviewed_at, '%Y-%m-%d %H:%i') AS reviewed_at,
              DATE_FORMAT(submitted_at, '%Y-%m-%d %H:%i') AS submitted_at
       FROM distributor_applicationstab
       ${whereSql}
       ORDER BY submitted_at DESC, id DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    const [allCount] = await pool.query('SELECT COUNT(*) AS total FROM distributor_applicationstab');
    const [newCount] = await pool.query("SELECT COUNT(*) AS total FROM distributor_applicationstab WHERE follow_up_status = 'new'");
    const [followedUpCount] = await pool.query("SELECT COUNT(*) AS total FROM distributor_applicationstab WHERE follow_up_status = 'followed_up'");
    const [cancelledCount] = await pool.query("SELECT COUNT(*) AS total FROM distributor_applicationstab WHERE follow_up_status = 'cancelled'");
    const [doneCount] = await pool.query("SELECT COUNT(*) AS total FROM distributor_applicationstab WHERE follow_up_status = 'done'");

    res.json({
      applications: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        sponsorName: row.sponsor_name,
        age: Number(row.age),
        phone: row.phone,
        email: row.email,
        status: row.status,
        followUpStatus: row.follow_up_status,
        adminNote: row.admin_note,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        submittedAt: row.submitted_at,
      })),
      counts: {
        all: Number(allCount[0]?.total || 0),
        new: Number(newCount[0]?.total || 0),
        followed_up: Number(followedUpCount[0]?.total || 0),
        cancelled: Number(cancelledCount[0]?.total || 0),
        done: Number(doneCount[0]?.total || 0),
      },
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    });
  } catch (err) {
    console.error('[Admin Applications] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/follow-up/:status', adminAuth, adminRights([1, 3]), (req, res) => {
  const followUpStatus = String(req.params.status || '').toLowerCase();
  if (!FOLLOW_UP_STATUSES.has(followUpStatus) || followUpStatus === 'new') {
    return res.status(400).json({ error: 'Invalid follow-up status.' });
  }
  return updateFollowUpStatus(req, res, followUpStatus);
});

module.exports = router;
