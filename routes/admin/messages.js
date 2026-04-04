/**
 * Admin contact messages routes
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');

async function ensureContactMessagesTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS contact_messagestab (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(200) DEFAULT NULL,
      subject VARCHAR(255) DEFAULT NULL,
      message TEXT NOT NULL,
      status TINYINT NOT NULL DEFAULT 0,
      ip_address VARCHAR(45) DEFAULT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_status (status),
      KEY idx_submitted_at (submitted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function normalizeStatusFilter(raw) {
  const v = String(raw || 'all').toLowerCase();
  if (v === 'unread') return 0;
  if (v === 'read') return 1;
  if (v === 'resolved') return 2;
  return 'all';
}

function statusLabel(status) {
  if (Number(status) === 2) return 'Resolved';
  if (Number(status) === 1) return 'Read';
  return 'Unread';
}

/**
 * GET /api/admin/messages?page=1&status=all
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
    const offset = (page - 1) * perPage;
    const statusFilter = normalizeStatusFilter(req.query.status);

    let whereSql = '';
    const params = [];
    if (statusFilter !== 'all') {
      whereSql = 'WHERE status = ?';
      params.push(statusFilter);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM contact_messagestab ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT id, name, email, subject, message, status, ip_address,
              DATE_FORMAT(submitted_at, '%Y-%m-%d %H:%i') AS submitted_at
       FROM contact_messagestab
       ${whereSql}
       ORDER BY submitted_at DESC, id DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    const [allCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab');
    const [unreadCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab WHERE status = 0');
    const [readCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab WHERE status = 1');
    const [resolvedCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab WHERE status = 2');

    res.json({
      messages: rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        email: r.email,
        subject: r.subject,
        message: r.message,
        status: Number(r.status || 0),
        statusLabel: statusLabel(r.status),
        submittedAt: r.submitted_at,
        ipAddress: r.ip_address,
      })),
      counts: {
        all: Number(allCount[0]?.total || 0),
        unread: Number(unreadCount[0]?.total || 0),
        read: Number(readCount[0]?.total || 0),
        resolved: Number(resolvedCount[0]?.total || 0),
      },
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    });
  } catch (err) {
    console.error('[Admin Messages] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/messages/:id/read
 */
router.put('/:id/read', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    const id = Number(req.params.id);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const [result] = await pool.query(
      'UPDATE contact_messagestab SET status = 1 WHERE id = ? LIMIT 1',
      [id]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, status: 1, statusLabel: 'Read' });
  } catch (err) {
    console.error('[Admin Messages] Mark read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/messages/:id/resolve
 */
router.put('/:id/resolve', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    const id = Number(req.params.id);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const [result] = await pool.query(
      'UPDATE contact_messagestab SET status = 2 WHERE id = ? LIMIT 1',
      [id]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, status: 2, statusLabel: 'Resolved' });
  } catch (err) {
    console.error('[Admin Messages] Resolve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
