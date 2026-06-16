-- V030: Support message delivery/read receipts.
-- Adds per-message delivered_at and read_at timestamps so the chat UI can show
-- sent / delivered / read ticks. Additive and idempotent; safe to re-run.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticket_repliestab ADD COLUMN delivered_at TIMESTAMP(6) NULL AFTER created_at',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticket_repliestab' AND COLUMN_NAME = 'delivered_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticket_repliestab ADD COLUMN read_at TIMESTAMP(6) NULL AFTER delivered_at',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticket_repliestab' AND COLUMN_NAME = 'read_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: treat all pre-existing messages as delivered (they were already
-- shown in the old modal UI) so they don't all render as a perpetual single tick.
UPDATE support_ticket_repliestab SET delivered_at = created_at WHERE delivered_at IS NULL;
