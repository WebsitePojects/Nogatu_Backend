-- V036: split maintenance points into UNILEVEL vs HIFIVE buckets.
--
-- Each producttype>=100 repurchase is tagged at code-use time. The unilevel monthly
-- maintenance gate (>=200/month) counts bucket='unilevel'; the Hi-Five product
-- free-claim tracking counts bucket='hifive'. Legacy rows default to 'unilevel'
-- (their historical behavior — they always fed the unilevel maintenance total).
--
-- Additive + idempotent: re-running is a no-op.

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'repurchasetab'
    AND COLUMN_NAME = 'maintenance_bucket'
);
SET @sql := IF(@col_exists = 0,
  "ALTER TABLE repurchasetab ADD COLUMN maintenance_bucket ENUM('unilevel','hifive') NOT NULL DEFAULT 'unilevel' AFTER producttype",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Keep per-bucket monthly sums (WHERE uid=? AND maintenance_bucket=? AND transdate in month) fast.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'repurchasetab'
    AND INDEX_NAME = 'idx_uid_bucket_transdate'
);
-- ALGORITHM=INPLACE, LOCK=NONE => InnoDB builds the index online (concurrent reads+writes
-- allowed), avoiding a write-lock on the large repurchasetab. The ADD COLUMN above is
-- metadata-only / INSTANT on MySQL 8.0.12+. If the target server is older (5.7) and the
-- table is very large, run V036 inside the brief deploy window.
SET @sql2 := IF(@idx_exists = 0,
  'ALTER TABLE repurchasetab ADD INDEX idx_uid_bucket_transdate (uid, maintenance_bucket, transdate), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;
