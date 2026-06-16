const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { createPublicId } = require('../utils/security');
const { writeAuditLog } = require('../services/audit');
const { SCHEMA_REQUIREMENTS, assertSchemaReadyOnce } = require('../services/schemaReadiness');
const { handleSupportUpload, uploadSupportMedia, createUploadSignature, validateAttachments, deleteSupportUpload } = require('../utils/supportMedia');
const { insertAttachments, attachmentsByReply } = require('../services/supportAttachments');
const events = require('./events');

const STATUS_LABELS = {
  open: 'Open',
  in_review: 'In Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

function statusLabel(status) {
  return STATUS_LABELS[String(status)] || 'Open';
}

function memberKey(req) {
  return String(req.session?.uid || req.ip);
}

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: memberKey,
  message: { error: 'You are creating tickets too quickly. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const replyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: memberKey,
  message: { error: 'You are sending messages too quickly. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function memberName(uid, session) {
  const [rows] = await pool.query(
    'SELECT firstname, lastname, email FROM memberstab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const member = rows[0] || {};
  const name = `${member.firstname || session.shortname || ''} ${member.lastname || ''}`.trim()
    || session.username
    || `Member ${uid}`;
  const email = String(member.email || '').trim() || null;
  return { name, email };
}

async function formattedReplyTime(conn, replyUid) {
  const [rows] = await conn.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
     FROM support_ticket_repliestab WHERE reply_uid = ? LIMIT 1`,
    [replyUid]
  );
  return rows[0]?.created_at || null;
}

// Resolve an optional uploaded media file into { url, type } or null; on a
// configuration/upload failure, responds and returns undefined (caller stops).
async function resolveAttachment(req, res) {
  if (!req.file) return null;
  try {
    return await uploadSupportMedia(req.file);
  } catch (error) {
    res.status(error.code === 'UPLOAD_NOT_CONFIGURED' ? 503 : 400)
      .json({ error: error.message || 'Unable to upload attachment.' });
    return undefined;
  }
}

function attachmentPreview(type) {
  return `[${type === 'video' ? 'Video' : 'Image'} attachment]`;
}

async function ensureSupportSchema(_req, res, next) {
  try {
    await assertSchemaReadyOnce('SUPPORT', SCHEMA_REQUIREMENTS.SUPPORT, 'Support tickets');
    next();
  } catch (error) {
    if (error.code === 'SCHEMA_NOT_READY') {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
}

/**
 * POST /api/support/ticket
 * Create a new ticket. Accepts an optional image/video attachment (multipart
 * field `media`). The opening message is written as the ticket preview and as
 * row #1 of the conversation in a single transaction.
 */
router.post('/ticket', memberAuth, createLimiter, ensureSupportSchema, handleSupportUpload, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const subject = String(req.body.subject || '').trim().slice(0, 180);
    const message = String(req.body.message || '').trim().slice(0, 5000);

    const attachment = await resolveAttachment(req, res);
    if (attachment === undefined) return undefined;

    if (!subject || (!message && !attachment)) {
      return res.status(400).json({ error: 'Subject and a message or attachment are required.' });
    }

    const { name, email } = await memberName(uid, req.session);
    const ticketUid = createPublicId();
    const replyUid = createPublicId();
    const requestId = req.requestId || req.headers['x-request-id'] || 'support-ticket';
    const previewMessage = message || attachmentPreview(attachment.type);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO support_ticketstab
         (ticket_uid, member_uid, name, email, subject, message, request_id,
          status, member_unread, admin_unread, last_reply_at, last_reply_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, 1, CURRENT_TIMESTAMP(6), 'member')`,
        [ticketUid, uid, name, email, subject, previewMessage, requestId]
      );
      await conn.query(
        `INSERT INTO support_ticket_repliestab
         (reply_uid, ticket_uid, author_role, author_uid, admin_username, author_name, body, attachment_url, attachment_type)
         VALUES (?, ?, 'member', ?, NULL, ?, ?, ?, ?)`,
        [replyUid, ticketUid, uid, name, message, attachment?.url || null, attachment?.type || null]
      );
      await conn.commit();
    } catch (txErr) {
      try { await conn.rollback(); } catch { /* already closed */ }
      throw txErr;
    } finally {
      conn.release();
    }

    await writeAuditLog({
      req,
      actorUid: uid,
      actorRole: 'member',
      action: 'support.ticket.create',
      targetUid: uid,
      targetTable: 'support_ticketstab',
      targetId: ticketUid,
      afterState: { subject },
    });

    res.status(201).json({ success: true, ticketUid, name, email, status: 'open' });
  } catch (err) {
    console.error('[Support] ticket error:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Support tickets are not ready yet. Please run database migrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/support/uploads/sign — issue a Cloudinary signed-upload payload so the
 * BROWSER uploads files directly to Cloudinary (server never proxies the bytes).
 */
router.post('/uploads/sign', memberAuth, (req, res) => {
  const payload = createUploadSignature('nogatu/support');
  if (!payload) return res.status(503).json({ error: 'Media upload is not configured.' });
  res.json(payload);
});

/**
 * POST /api/support/uploads/delete — discard a staged Cloudinary upload before send.
 */
router.post('/uploads/delete', memberAuth, async (req, res) => {
  await deleteSupportUpload(req.body?.publicId, req.body?.type);
  res.json({ success: true });
});

/**
 * GET /api/support/meta/unread-count — member's unread ticket count (header badge).
 * Under /meta/ so it never collides with /tickets/:ticketUid.
 */
router.get('/meta/unread-count', memberAuth, ensureSupportSchema, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS unread FROM support_ticketstab WHERE member_uid = ? AND member_unread = 1',
      [uid]
    );
    res.json({ unread: Number(rows[0]?.unread || 0) });
  } catch (err) {
    console.error('[Support] member unread-count error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/support/tickets — list the member's own tickets.
 */
router.get('/tickets', memberAuth, ensureSupportSchema, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const [rows] = await pool.query(
      `SELECT ticket_uid, subject, status, member_unread, last_reply_role,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at,
              DATE_FORMAT(last_reply_at, '%Y-%m-%d %H:%i') AS last_activity
       FROM support_ticketstab
       WHERE member_uid = ?
       ORDER BY last_reply_at DESC, id DESC
       LIMIT 100`,
      [uid]
    );

    res.json({
      tickets: rows.map((r) => ({
        ticketUid: r.ticket_uid,
        subject: r.subject,
        status: r.status,
        statusLabel: statusLabel(r.status),
        unread: Number(r.member_unread) === 1,
        lastReplyRole: r.last_reply_role,
        createdAt: r.created_at,
        lastActivity: r.last_activity,
      })),
    });
  } catch (err) {
    console.error('[Support] list tickets error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/support/tickets/:ticketUid — full thread; clears member unread.
 */
router.get('/tickets/:ticketUid', memberAuth, ensureSupportSchema, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const ticketUid = String(req.params.ticketUid || '').trim();

    const [ticketRows] = await pool.query(
      `SELECT ticket_uid, member_uid, name, subject, message, status,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM support_ticketstab
       WHERE ticket_uid = ? LIMIT 1`,
      [ticketUid]
    );
    const ticket = ticketRows[0];
    if (!ticket || Number(ticket.member_uid) !== uid) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const [replyRows] = await pool.query(
      `SELECT reply_uid, author_role, author_name, admin_username, body, attachment_url, attachment_type,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at,
              delivered_at, read_at
       FROM support_ticket_repliestab
       WHERE ticket_uid = ?
       ORDER BY created_at ASC, id ASC`,
      [ticketUid]
    );

    // Opening the thread = member has now seen all admin messages: mark them read.
    await pool.query(
      `UPDATE support_ticket_repliestab
         SET read_at = CURRENT_TIMESTAMP(6)
       WHERE ticket_uid = ? AND author_role = 'admin' AND read_at IS NULL`,
      [ticketUid]
    );
    await pool.query(
      'UPDATE support_ticketstab SET member_unread = 0 WHERE ticket_uid = ? LIMIT 1',
      [ticketUid]
    );
    // Tell admins the member read their messages (updates ticks live).
    events.publishToAdmins('support.read', { ticketUid, by: 'member' });

    const attachMap = await attachmentsByReply(replyRows.map((r) => r.reply_uid));
    const messages = buildMessages(replyRows, ticket).map((m) => ({
      ...m,
      attachments: attachMap.get(m.replyUid) || (m.attachmentUrl ? [{ type: m.attachmentType || 'image', url: m.attachmentUrl }] : []),
    }));

    res.json({
      ticket: {
        ticketUid: ticket.ticket_uid,
        subject: ticket.subject,
        status: ticket.status,
        statusLabel: statusLabel(ticket.status),
        createdAt: ticket.created_at,
      },
      messages,
    });
  } catch (err) {
    console.error('[Support] thread error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/support/tickets/:ticketUid/reply
 * Member adds a message and/or an image/video attachment.
 */
router.post('/tickets/:ticketUid/reply', memberAuth, replyLimiter, ensureSupportSchema, handleSupportUpload, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const ticketUid = String(req.params.ticketUid || '').trim();
    const body = String(req.body.message || req.body.body || '').trim().slice(0, 5000);

    // Legacy single-file path (multipart) still works; new path is a JSON array of
    // already-direct-uploaded Cloudinary URLs (up to 5 images + 1 video).
    const attachment = await resolveAttachment(req, res);
    if (attachment === undefined) return undefined;
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
    if (!ticket || Number(ticket.member_uid) !== uid) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (ticket.status === 'closed') {
      return res.status(409).json({ error: 'This ticket is closed. Please open a new ticket.' });
    }

    const { name } = await memberName(uid, req.session);
    const replyUid = createPublicId();
    const firstAttachment = attachments[0] || null;

    await pool.query(
      `INSERT INTO support_ticket_repliestab
       (reply_uid, ticket_uid, author_role, author_uid, admin_username, author_name, body, attachment_url, attachment_type)
       VALUES (?, ?, 'member', ?, NULL, ?, ?, ?, ?)`,
      [replyUid, ticketUid, uid, name, body, firstAttachment?.url || null, firstAttachment?.type || null]
    );
    await insertAttachments(pool, replyUid, ticketUid, attachments);

    const nextStatus = ticket.status === 'resolved' ? 'open' : ticket.status;
    await pool.query(
      `UPDATE support_ticketstab
       SET admin_unread = 1, member_unread = 0,
           last_reply_at = CURRENT_TIMESTAMP(6), last_reply_role = 'member',
           status = ?
       WHERE ticket_uid = ? LIMIT 1`,
      [nextStatus, ticketUid]
    );

    const createdAt = await formattedReplyTime(pool, replyUid);

    // Push to any connected admins. If at least one admin stream received it,
    // the message is 'delivered'; otherwise it stays 'sent' until an admin loads.
    const replyPayload = {
      ticketUid,
      replyUid,
      authorRole: 'member',
      authorName: name,
      body,
      attachmentUrl: firstAttachment?.url || null,
      attachmentType: firstAttachment?.type || null,
      attachments: attachments.map((a) => ({ type: a.type, url: a.url })),
      createdAt,
    };
    const delivered = events.publishToAdmins('support.reply', replyPayload);
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
    console.error('[Support] member reply error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Derive a sent/delivered/read status for a message from its receipt timestamps.
function receiptStatus(row) {
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'sent';
}

function buildMessages(replyRows, ticket) {
  if (replyRows.length > 0) {
    return replyRows.map((r) => ({
      replyUid: r.reply_uid,
      authorRole: r.author_role,
      authorName: r.author_name,
      // Never expose the admin's login username to members (privacy). Members see
      // only the display name (e.g. "Support Team"). Admins still see usernames.
      authorUsername: null,
      body: r.body,
      attachmentUrl: r.attachment_url || null,
      attachmentType: r.attachment_type || null,
      createdAt: r.created_at,
      status: receiptStatus(r),
    }));
  }
  return [{
    replyUid: 'root',
    authorRole: 'member',
    authorName: ticket.name,
    body: ticket.message,
    attachmentUrl: null,
    attachmentType: null,
    createdAt: ticket.created_at,
    status: 'sent',
  }];
}

module.exports = router;
