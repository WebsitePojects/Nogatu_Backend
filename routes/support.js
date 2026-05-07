const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { createPublicId } = require('../utils/security');
const { writeAuditLog } = require('../services/audit');

router.post('/ticket', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const subject = String(req.body.subject || '').trim().slice(0, 180);
    const message = String(req.body.message || '').trim().slice(0, 5000);

    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required.' });
    }

    const [memberRows] = await pool.query(
      `SELECT firstname, lastname, email
       FROM memberstab
       WHERE uid = ?
       LIMIT 1`,
      [uid]
    );
    const member = memberRows[0] || {};
    const name = `${member.firstname || req.session.shortname || ''} ${member.lastname || ''}`.trim() || req.session.username || `Member ${uid}`;
    const email = String(member.email || '').trim() || null;
    const ticketUid = createPublicId();

    await pool.query(
      `INSERT INTO support_ticketstab
       (ticket_uid, member_uid, name, email, subject, message, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ticketUid, uid, name, email, subject, message, req.requestId || req.headers['x-request-id'] || 'support-ticket']
    );

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

    res.status(201).json({
      success: true,
      ticketUid,
      name,
      email,
      status: 'open',
    });
  } catch (err) {
    console.error('[Support] ticket error:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Support tickets are not ready yet. Please run database migrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
