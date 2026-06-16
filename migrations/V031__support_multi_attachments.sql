-- V031: Support multi-attachment support (up to 5 images + 1 video per message).
-- One row per attachment instead of the single attachment_url/type columns on the
-- reply (those are kept for backward compatibility with existing messages).
-- Attachments are uploaded BROWSER -> Cloudinary directly (signed); we store only
-- the resulting URL + public_id (for deletion). No blobs in MySQL.

CREATE TABLE IF NOT EXISTS support_message_attachmentstab (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reply_uid   CHAR(36) NOT NULL,
  ticket_uid  CHAR(36) NOT NULL,
  line_no     INT UNSIGNED NOT NULL DEFAULT 0,   -- chronological order within the message
  media_type  VARCHAR(16) NOT NULL,              -- 'image' | 'video'
  url         VARCHAR(600) NOT NULL,
  public_id   VARCHAR(255) NULL,                 -- Cloudinary public_id, for deletion
  width       INT UNSIGNED NULL,
  height      INT UNSIGNED NULL,
  bytes       BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_reply (reply_uid, line_no),
  KEY idx_ticket (ticket_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill: migrate existing single attachments into the new table so the UI can
-- render everything through one path. Idempotent (skips replies already migrated).
INSERT INTO support_message_attachmentstab (reply_uid, ticket_uid, line_no, media_type, url)
SELECT r.reply_uid, r.ticket_uid, 0,
       COALESCE(r.attachment_type, 'image'), r.attachment_url
FROM support_ticket_repliestab r
LEFT JOIN support_message_attachmentstab a ON a.reply_uid = r.reply_uid
WHERE r.attachment_url IS NOT NULL AND r.attachment_url <> '' AND a.id IS NULL;
