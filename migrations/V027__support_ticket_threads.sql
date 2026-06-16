-- V027: Support ticket threaded conversation (mini chatroom)
--
-- Data model: support_ticketstab holds ticket metadata + a denormalized
-- preview of the opening message (the `message` column). The full, ordered
-- conversation — including the opening message as row #1 — lives in
-- support_ticket_repliestab, which is the single source of truth for the thread.

CREATE TABLE IF NOT EXISTS support_ticket_repliestab (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reply_uid      CHAR(36) NOT NULL,
  ticket_uid     CHAR(36) NOT NULL,
  author_role    ENUM('member','admin') NOT NULL,
  author_uid     INT NULL,              -- member uid (NULL for admin authors)
  admin_username VARCHAR(120) NULL,     -- durable staff identity (NULL for member authors)
  author_name    VARCHAR(160) NOT NULL, -- display-name snapshot at time of writing
  body           TEXT NOT NULL,
  created_at     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_reply_uid (reply_uid),
  KEY idx_ticket (ticket_uid, created_at),
  KEY idx_author (author_role, author_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Thread bookkeeping columns on the parent ticket ──────────────────────────
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD COLUMN last_reply_at TIMESTAMP(6) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND COLUMN_NAME = 'last_reply_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD COLUMN last_reply_role VARCHAR(16) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND COLUMN_NAME = 'last_reply_role'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- member_unread: admin replied, member has not opened the thread since.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD COLUMN member_unread TINYINT NOT NULL DEFAULT 0',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND COLUMN_NAME = 'member_unread'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- admin_unread: member created or replied, admin has not opened the thread since.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD COLUMN admin_unread TINYINT NOT NULL DEFAULT 1',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND COLUMN_NAME = 'admin_unread'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Index supporting the activity-ordered list queries (avoids filesort) ─────
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD INDEX idx_status_activity (status, last_reply_at)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND INDEX_NAME = 'idx_status_activity'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD INDEX idx_member_activity (member_uid, last_reply_at)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND INDEX_NAME = 'idx_member_activity'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticketstab ADD INDEX idx_admin_unread (admin_unread, last_reply_at)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticketstab' AND INDEX_NAME = 'idx_admin_unread'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Backfill: ensure last_reply_at is never NULL so ordering is stable ───────
UPDATE support_ticketstab SET last_reply_at = created_at WHERE last_reply_at IS NULL;

-- ── Backfill: migrate each existing ticket's opening message into the thread ──
-- Idempotent: only inserts for tickets that have no reply rows yet.
INSERT INTO support_ticket_repliestab
  (reply_uid, ticket_uid, author_role, author_uid, admin_username, author_name, body, created_at)
SELECT UUID(), t.ticket_uid, 'member', t.member_uid, NULL, t.name, t.message, t.created_at
FROM support_ticketstab t
LEFT JOIN support_ticket_repliestab r ON r.ticket_uid = t.ticket_uid
WHERE r.id IS NULL;
