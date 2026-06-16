-- V029: Support ticket reply attachments (image / video).
-- Members and staff can attach one media file per message; the URL is stored
-- here (uploaded to Cloudinary) alongside its type.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticket_repliestab ADD COLUMN attachment_url VARCHAR(500) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticket_repliestab' AND COLUMN_NAME = 'attachment_url'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE support_ticket_repliestab ADD COLUMN attachment_type VARCHAR(16) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_ticket_repliestab' AND COLUMN_NAME = 'attachment_type'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
