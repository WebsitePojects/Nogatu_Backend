-- V044: index usertab.activationcode
--
-- Registration and upgrade now re-check, before consuming a code, that no existing
-- member already holds it (services/codeConsumption.js). usertab carries only a
-- PRIMARY KEY on uid, so without this index that check is a full table scan on every
-- encode. With it the check is a single seek and adds no measurable time.
--
-- NOT unique. Production genuinely holds a handful of legacy rows that share an
-- activationcode, and a UNIQUE index would fail to build against that data. This
-- index exists for lookup speed only; the correctness gate lives in application code.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE usertab ADD INDEX idx_activationcode (activationcode)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'usertab'
    AND INDEX_NAME = 'idx_activationcode'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
