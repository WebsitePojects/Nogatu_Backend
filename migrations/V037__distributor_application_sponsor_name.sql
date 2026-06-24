-- V037: add sponsor full name field to distributor applications.
--
-- The public distributor application form now asks for the sponsoring
-- member's full name alongside the applicant's own name/contact/email.
-- Additive + idempotent: re-running is a no-op.

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'distributor_applicationstab'
    AND COLUMN_NAME = 'sponsor_name'
);
SET @sql := IF(@col_exists = 0,
  "ALTER TABLE distributor_applicationstab ADD COLUMN sponsor_name VARCHAR(150) NULL AFTER name",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
