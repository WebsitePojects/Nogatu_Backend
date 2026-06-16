/**
 * Admin support ticket routes — the staff side of the mini chatroom.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { createPublicId } = require('../../utils/security');
const { writeAuditLog } = require('../../services/audit');
const { SCHEMA_REQUIREMENTS, assertSchemaReadyOnce } = require('../../services/schemaReadiness');
const { handleSupportUpload, uploadSupportMedia, createUploadSignature, validateAttachments, deleteSupportUpload } = require('../../utils/supportMedia');
const { insertAttachments, attachmentsByReply } = require('../../services/supportAttachments');
const events = require('../events');

function receiptStatus(row) {
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'sent';
}

const VALID_STATUS = ['open', 'in_review', 'resolved', 'closed'];
const STATUS_LABELS = {
  open: 'Open',
  in_review: 'In Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

function statusLabel(status) {
  return STATUS_LABELS[String(status)] || 'Open';
}

const replyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => String(req.session?.adminid || req.ip),
  message: { error: 'Too many replies in a short time. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(adminAuth, adminRights([1, 3]));
router.use(async (_req, res, next) => {
  try {
    await assertSchemaReadyOnce('SUPPORT', SCHEMA_REQUIREMENTS.SUPPORT, 'Support tickets');
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

function normalizeStatusFilter(raw) {
  const v = String(raw || 'all').toLowerCase();
  if (VALID_STATUS.includes(v)) return v;
  if (v === 'unread') return 'unread';
  return 'all';
}

async function formattedReplyTime(replyUid) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
     FROM support_ticket_repliestab WHERE reply_uid = ? LIMIT 1`,
    [replyUid]
  );
  return rows[0]?.created_at || null;
}

/**
 * POST /api/admin/support/uploads/sign — Cloudinary signed-upload payload for
 * browser-direct uploads (server never proxies bytes).
 */
router.post('/uploads/sign', (req, res) => {
  const payload = createUploadSignature('nogatu/support');
  if (!payload) return res.status(503).json({ error: 'Media upload is not configured.' });
  res.json(payload);
});

/** POST /api/admin/support/uploads/delete — discard a staged upload. */
router.post('/uploads/delete', async (req, res) => {
  await deleteSupportUpload(req.body?.publicId, req.body?.type);
  res.json({ success: true });
});

/**
 * GET /api/admin/support?page=1&perPage=20&status=all
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
    const offset = (page - 1) * perPage;
    const statusFilter = normalizeStatusFilter(req.query.status);

    let whereSql = '';
    const params = [];
    if (statusFilter === 'unread') {
      whereSql = 'WHERE admin_unread = 1';
    } else if (statusFilter !== 'all') {
      whereSql = 'WHERE status = ?';
      params.push(statusFilter);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM support_ticketstab ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT ticket_uid, member_uid, name, email, subject, status, admin_unread, last_reply_role,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at,
              DATE_FORMAT(last_reply_at, '%Y-%m-%d %H:%i') AS last_activity
       FROM support_ticketstab
       ${whereSql}
       ORDER BY last_reply_at DESC, id DESC
       LIMIT ?, ?`,
      [...params, offset, perPage]
    );

    const [countsRows] = await pool.query(
      `SELECT
         COUNT(*) AS all_count,
         SUM(admin_unread = 1) AS unread,
         SUM(status = 'open') AS open_count,
         SUM(status = 'in_review') AS in_review,
         SUM(status = 'resolved') AS resolved,
         SUM(status = 'closed') AS closed
       FROM support_ticketstab`
    );
    const c = countsRows[0] || {};

    res.json({
      tickets: rows.map((r) => ({
        ticketUid: r.ticket_uid,
        memberUid: Number(r.member_uid),
        name: r.name,
        email: r.email,
        subject: r.subject,
        status: r.status,
        statusLabel: statusLabel(r.status),
        unread: Number(r.admin_unread) === 1,
        lastReplyRole: r.last_reply_role,
        createdAt: r.created_at,
        lastActivity: r.last_activity,
      })),
      counts: {
        all: Number(c.all_count || 0),
        unread: Number(c.unread || 0),
        open: Number(c.open_count || 0),
        in_review: Number(c.in_review || 0),
        resolved: Number(c.resolved || 0),
        closed: Number(c.closed || 0),
      },
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    });
  } catch (err) {
    console.error('[Admin Support] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/support/:ticketUid — full thread. Clears the admin unread flag.
 */
router.get('/:ticketUid', async (req, res) => {
  try {
    const ticketUid = String(req.params.ticketUid || '').trim();

    const [ticketRows] = await pool.query(
      `SELECT ticket_uid, member_uid, name, email, subject, message, status,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM support_ticketstab
       WHERE ticket_uid = ? LIMIT 1`,
      [ticketUid]
    );
    const ticket = ticketRows[0];
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const [replyRows] = await pool.query(
      `SELECT r.reply_uid, r.author_role, r.author_name, r.admin_username, r.author_uid,
              mem.username AS member_username,
              r.body, r.attachment_url, r.attachment_type,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i') AS created_at,
              r.delivered_at, r.read_at
       FROM support_ticket_repliestab r
       LEFT JOIN memberstab mem ON mem.uid = r.author_uid
       WHERE r.ticket_uid = ?
       ORDER BY r.created_at ASC, r.id ASC`,
      [ticketUid]
    );

    // Admin opened the thread = they've seen the member's messages: mark read.
    await pool.query(
      `UPDATE support_ticket_repliestab
         SET read_at = CURRENT_TIMESTAMP(6)
       WHERE ticket_uid = ? AND author_role = 'member' AND read_at IS NULL`,
      [ticketUid]
    );
    await pool.query(
      'UPDATE support_ticketstab SET admin_unread = 0 WHERE ticket_uid = ? LIMIT 1',
      [ticketUid]
    );
    // Tell the member their messages were read (updates their ticks live).
    events.publishToUser(Number(ticket.member_uid), 'support.read', { ticketUid, by: 'admin' });

    const messages = replyRows.length > 0
      ? replyRows.map((r) => ({
          replyUid: r.reply_uid,
          authorRole: r.author_role,
          authorName: r.author_name,
          authorUsername: r.author_role === 'admin' ? (r.admin_username || null) : (r.member_username || null),
          body: r.body,
          attachmentUrl: r.attachment_url || null,
          attachmentType: r.attachment_type || null,
          attachments: [],
          createdAt: r.created_at,
          status: receiptStatus(r),
        }))
      : [{ replyUid: 'root', authorRole: 'member', authorName: ticket.name, body: ticket.message, attachmentUrl: null, attachmentType: null, attachments: [], createdAt: ticket.created_at, status: 'sent' }];
    const attachMap = await attachmentsByReply(replyRows.map((r) => r.reply_uid));
    for (const m of messages) {
      m.attachments = attachMap.get(m.replyUid) || (m.attachmentUrl ? [{ type: m.attachmentType || 'image', url: m.attachmentUrl }] : []);
    }

    res.json({
      ticket: {
        ticketUid: ticket.ticket_uid,
        memberUid: Number(ticket.member_uid),
        name: ticket.name,
        email: ticket.email,
        subject: ticket.subject,
        status: ticket.status,
        statusLabel: statusLabel(ticket.status),
        createdAt: ticket.created_at,
      },
      messages,
    });
  } catch (err) {
    console.error('[Admin Support] thread error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/support/:ticketUid/reply
 * Staff replies; an open ticket moves to in_review and the member is flagged.
 */
router.post('/:ticketUid/reply', replyLimiter, handleSupportUpload, async (req, res) => {
  try {
    const ticketUid = String(req.params.ticketUid || '').trim();
    const body = String(req.body.message || req.body.body || '').trim().slice(0, 5000);
    const adminName = String(req.session.adminname || 'Support Team').trim().slice(0, 160);
    const adminUsername = String(req.session.adminid || 'admin').slice(0, 120);

    let attachment = null;
    if (req.file) {
      try {
        attachment = await uploadSupportMedia(req.file);
      } catch (error) {
        return res.status(error.code === 'UPLOAD_NOT_CONFIGURED' ? 503 : 400)
          .json({ error: error.message || 'Unable to upload attachment.' });
      }
    }
    const av = validateAttachments(req.body.attachments);
    if (!av.ok) return res.status(400).json({ error: av.error });
    const attachments = av.attachments;
    if (attachment) attachments.unshift({ type: attachment.type, url: attachment.url, publicId: null });

    if (!body && attachments.length === 0) {
      return res.status(400).json({ error: 'Message or attachment is required.' });
    }

    const [ticketRows] = await pool.query(
      'SELECT member_uid, status FROM support_ticketstab WHERE ticket_uid = ? LIMIT 1',
      [ticketUid]
    );
    const ticket = ticketRows[0];
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (ticket.status === 'closed') {
      return res.status(409).json({ error: 'This ticket is closed. Reopen it before replying.' });
    }

    const replyUid = createPublicId();
    const firstAttachment = attachments[0] || null;
    await pool.query(
      `INSERT INTO support_ticket_repliestab
       (reply_uid, ticket_uid, author_role, author_uid, admin_username, author_name, body, attachment_url, attachment_type)
       VALUES (?, ?, 'admin', NULL, ?, ?, ?, ?, ?)`,
      [replyUid, ticketUid, adminUsername, adminName, body, firstAttachment?.url || null, firstAttachment?.type || null]
    );
    await insertAttachments(pool, replyUid, ticketUid, attachments);

    const nextStatus = ticket.status === 'open' ? 'in_review' : ticket.status;
    await pool.query(
      `UPDATE support_ticketstab
       SET member_unread = 1, admin_unread = 0,
           last_reply_at = CURRENT_TIMESTAMP(6), last_reply_role = 'admin',
           status = ?
       WHERE ticket_uid = ? LIMIT 1`,
      [nextStatus, ticketUid]
    );

    await writeAuditLog({
      req,
      actorUid: null,
      actorRole: 'admin',
      action: 'support.ticket.reply',
      targetUid: Number(ticket.member_uid),
      targetTable: 'support_ticketstab',
      targetId: ticketUid,
      afterState: { admin: adminUsername },
    });

    const createdAt = await formattedReplyTime(replyUid);

    const replyPayload = {
      ticketUid,
      replyUid,
      authorRole: 'admin',
      authorName: adminName,
      authorUsername: adminUsername,
      body,
      attachmentUrl: firstAttachment?.url || null,
      attachmentType: firstAttachment?.type || null,
      attachments: attachments.map((a) => ({ type: a.type, url: a.url })),
      createdAt,
    };
    // Push to the member WITHOUT the admin's login username (privacy); admins get
    // the full payload including the username.
    const memberSafePayload = { ...replyPayload, authorUsername: null };
    const delivered = events.publishToUser(Number(ticket.member_uid), 'support.reply', memberSafePayload);
    events.publishToAdmins('support.reply', { ...replyPayload, adminEcho: true });
    let status = 'sent';
    if (delivered > 0) {
      await pool.query(
        'UPDATE support_ticket_repliestab SET delivered_at = CURRENT_TIMESTAMP(6) WHERE reply_uid = ? LIMIT 1',
        [replyUid]
      );
      status = 'delivered';
    }

    res.status(201).json({
      success: true,
      reply: { ...replyPayload, status },
      status: nextStatus,
      statusLabel: statusLabel(nextStatus),
    });
  } catch (err) {
    console.error('[Admin Support] reply error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/support/:ticketUid/status  { status }
 */
router.put('/:ticketUid/status', async (req, res) => {
  try {
    const ticketUid = String(req.params.ticketUid || '').trim();
    const status = String(req.body.status || '').trim().toLowerCase();
    const adminUsername = String(req.session.adminid || 'admin');

    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const [result] = await pool.query(
      'UPDATE support_ticketstab SET status = ? WHERE ticket_uid = ? LIMIT 1',
      [status, ticketUid]
    );
    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const [memRows] = await pool.query(
      'SELECT member_uid FROM support_ticketstab WHERE ticket_uid = ? LIMIT 1',
      [ticketUid]
    );
    const memberUid = memRows[0]?.member_uid;

    await writeAuditLog({
      req,
      actorUid: null,
      actorRole: 'admin',
      action: 'support.ticket.status',
      targetTable: 'support_ticketstab',
      targetId: ticketUid,
      afterState: { status, admin: adminUsername },
    });

    // Notify the member and other admins of the status change live.
    if (memberUid != null) {
      events.publishToUser(Number(memberUid), 'support.status', { ticketUid, status, statusLabel: statusLabel(status) });
    }
    events.publishToAdmins('support.status', { ticketUid, status, statusLabel: statusLabel(status) });

    res.json({ success: true, status, statusLabel: statusLabel(status) });
  } catch (err) {
    console.error('[Admin Support] status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/support/meta/unread-count — lightweight badge source.
 * (Under /meta/ so it never collides with /:ticketUid.)
 */
router.get('/meta/unread-count', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS unread FROM support_ticketstab WHERE admin_unread = 1"
    );
    res.json({ unread: Number(rows[0]?.unread || 0) });
  } catch (err) {
    console.error('[Admin Support] unread-count error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
