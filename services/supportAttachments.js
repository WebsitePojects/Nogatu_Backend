/**
 * Support message attachments — persistence + retrieval.
 * Attachments are uploaded browser->Cloudinary directly; here we only store/read
 * the resulting URL rows (tiny), batch-inserted in one query to protect the DB
 * under load. No file bytes ever pass through this process.
 */
const { pool } = require('../config/database');

/**
 * Batch-insert a message's attachments in ONE statement.
 * @param {object} conn  a pool or connection
 * @param {string} replyUid
 * @param {string} ticketUid
 * @param {Array<{type,url,publicId,width,height,bytes}>} attachments  already validated
 */
async function insertAttachments(conn, replyUid, ticketUid, attachments) {
  if (!attachments || attachments.length === 0) return;
  const rows = attachments.map((a, i) => [
    replyUid, ticketUid, i, a.type, a.url, a.publicId || null,
    a.width || null, a.height || null, a.bytes || null,
  ]);
  await conn.query(
    `INSERT INTO support_message_attachmentstab
       (reply_uid, ticket_uid, line_no, media_type, url, public_id, width, height, bytes)
     VALUES ?`,
    [rows]
  );
}

/**
 * Load attachments for a set of reply_uids, grouped by reply_uid in chronological
 * (line_no) order. One query for the whole thread (no N+1).
 * @returns {Map<string, Array<{type,url}>>}
 */
async function attachmentsByReply(replyUids) {
  const ids = (replyUids || []).filter(Boolean);
  if (ids.length === 0) return new Map();
  const [rows] = await pool.query(
    `SELECT reply_uid, media_type, url
       FROM support_message_attachmentstab
      WHERE reply_uid IN (?)
      ORDER BY reply_uid, line_no ASC, id ASC`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.reply_uid)) map.set(r.reply_uid, []);
    map.get(r.reply_uid).push({ type: r.media_type, url: r.url });
  }
  return map;
}

module.exports = { insertAttachments, attachmentsByReply };
