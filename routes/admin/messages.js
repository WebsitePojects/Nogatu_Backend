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

async function ensureContactBlocklistTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS contact_blockedtab (
      id INT NOT NULL AUTO_INCREMENT,
      email VARCHAR(200) DEFAULT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      blocked_by VARCHAR(120) DEFAULT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_email (email),
      KEY idx_ip_address (ip_address),
      KEY idx_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function normalizeStatusFilter(raw) {
  const v = String(raw || 'all').toLowerCase();
  if (v === 'unread') return 0;
  if (v === 'read') return 1;
  if (v === 'done' || v === 'resolved') return 2;
  if (v === 'blocked') return 3;
  return 'all';
}

function statusLabel(status) {
  if (Number(status) === 3) return 'Blocked';
  if (Number(status) === 2) return 'Done';
  if (Number(status) === 1) return 'Read';
  return 'Unread';
}

function parseMessageId(rawId) {
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

async function updateMessageStatus(id, status) {
  const [result] = await pool.query(
    'UPDATE contact_messagestab SET status = ? WHERE id = ? LIMIT 1',
    [status, id]
  );
  return result.affectedRows === 1;
}

/**
 * GET /api/admin/messages?page=1&status=all
 */
router.get('/', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    await ensureContactBlocklistTable();

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
    const [doneCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab WHERE status = 2');
    const [blockedCount] = await pool.query('SELECT COUNT(*) AS total FROM contact_messagestab WHERE status = 3');

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
        done: Number(doneCount[0]?.total || 0),
        resolved: Number(doneCount[0]?.total || 0),
        blocked: Number(blockedCount[0]?.total || 0),
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
    const id = parseMessageId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const updated = await updateMessageStatus(id, 1);
    if (!updated) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, status: 1, statusLabel: 'Read' });
  } catch (err) {
    console.error('[Admin Messages] Mark read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/messages/:id/done
 */
router.put('/:id/done', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    const id = parseMessageId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const updated = await updateMessageStatus(id, 2);
    if (!updated) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, status: 2, statusLabel: 'Done' });
  } catch (err) {
    console.error('[Admin Messages] Done error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/messages/:id/resolve
 * Backward-compatible alias to /done
 */
router.put('/:id/resolve', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    const id = parseMessageId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const updated = await updateMessageStatus(id, 2);
    if (!updated) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, status: 2, statusLabel: 'Done' });
  } catch (err) {
    console.error('[Admin Messages] Resolve alias error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/messages/:id/block
 * Block sender email/IP from future contact submissions.
 */
router.put('/:id/block', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    await ensureContactBlocklistTable();

    const id = parseMessageId(req.params.id);
    const reason = String(req.body?.reason || 'Blocked by admin').trim().slice(0, 255);
    const blockedBy = String(req.session.adminid || req.session.adminname || 'admin').trim().slice(0, 120);

    if (!id) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const [rows] = await pool.query(
      'SELECT id, email, ip_address FROM contact_messagestab WHERE id = ? LIMIT 1',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const senderEmail = String(rows[0].email || '').trim() || null;
    const senderIp = String(rows[0].ip_address || '').trim() || null;

    if (!senderEmail && !senderIp) {
      return res.status(400).json({ error: 'Sender has no blockable email or IP' });
    }

    if (senderEmail) {
      const [existingByEmail] = await pool.query(
        'SELECT id FROM contact_blockedtab WHERE active = 1 AND email = ? LIMIT 1',
        [senderEmail]
      );
      if (existingByEmail.length === 0) {
        await pool.query(
          `INSERT INTO contact_blockedtab
           (email, ip_address, reason, blocked_by, active, blocked_at)
           VALUES (?, NULL, ?, ?, 1, NOW())`,
          [senderEmail, reason, blockedBy]
        );
      }
    }

    if (senderIp) {
      const [existingByIp] = await pool.query(
        'SELECT id FROM contact_blockedtab WHERE active = 1 AND ip_address = ? LIMIT 1',
        [senderIp]
      );
      if (existingByIp.length === 0) {
        await pool.query(
          `INSERT INTO contact_blockedtab
           (email, ip_address, reason, blocked_by, active, blocked_at)
           VALUES (NULL, ?, ?, ?, 1, NOW())`,
          [senderIp, reason, blockedBy]
        );
      }
    }

    await updateMessageStatus(id, 3);

    res.json({ success: true, status: 3, statusLabel: 'Blocked' });
  } catch (err) {
    console.error('[Admin Messages] Block error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/messages/:id
 * Permanently delete a feedback message.
 */
router.delete('/:id', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    await ensureContactMessagesTable();
    const id = parseMessageId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Invalid message reference' });
    }

    const [result] = await pool.query(
      'DELETE FROM contact_messagestab WHERE id = ? LIMIT 1',
      [id]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Admin Messages] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
