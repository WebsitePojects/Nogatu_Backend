-- V043: index activation_code_usagetab.to_uid
-- The admin Voucher Management list resolves each voucher's source activation code
-- (and its search filter) through `acu.to_uid = v.uid`. to_uid has no index, so every
-- probe is a full scan of the usage table — searches took many seconds on prod.
-- (to_uid, id) also covers the "first event per recipient" ORDER BY ... LIMIT 1 probe.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE activation_code_usagetab ADD INDEX idx_to_uid_id (to_uid, id)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'activation_code_usagetab'
    AND INDEX_NAME = 'idx_to_uid_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
