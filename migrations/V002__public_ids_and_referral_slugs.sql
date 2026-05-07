-- Keep legacy integer usertab.uid internal while adding non-enumerable public identity.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE usertab ADD COLUMN public_uid CHAR(36) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usertab' AND COLUMN_NAME = 'public_uid'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE usertab ADD COLUMN referral_slug VARCHAR(32) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usertab' AND COLUMN_NAME = 'referral_slug'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE usertab
SET public_uid = UUID()
WHERE public_uid IS NULL OR public_uid = '';

UPDATE usertab
SET referral_slug = LOWER(LEFT(REPLACE(UUID(), '-', ''), 16))
WHERE referral_slug IS NULL OR referral_slug = '';

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'CREATE UNIQUE INDEX uq_usertab_public_uid ON usertab (public_uid)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usertab' AND INDEX_NAME = 'uq_usertab_public_uid'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'CREATE UNIQUE INDEX uq_usertab_referral_slug ON usertab (referral_slug)',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usertab' AND INDEX_NAME = 'uq_usertab_referral_slug'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
