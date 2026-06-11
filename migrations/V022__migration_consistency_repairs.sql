-- V022: Migration Consistency Repairs
--
-- Purpose:
--   Idempotent repair pass that fills gaps left by V001-V021 when the DB is
--   imported from a PHP production dump and migrations are re-run from scratch
--   on a fresh environment.
--
--   V019 and V021 already cover most scenarios.  This migration targets two
--   remaining edge cases:
--
--   1.  V011 added idx_usertab_account_status without an IF NOT EXISTS guard.
--       If account_status was manually added before V011 ran, V011 would fail.
--       V019 repairs the columns; this migration repairs the index.
--
--   2.  V017 created uq_memberstab_public_id and uq_memberstab_referral_slug
--       with bare CREATE UNIQUE INDEX (no guard).  V021 already guards these,
--       but V021 only runs if V017 ran first.  If V017 fails, V021 never runs.
--       This migration adds a final-safety-net layer independent of that order.
--
--   3.  Ensures pairing_ledgerstab.ledger_uid is CHAR(64) on any environment
--       where V020 or V021 was skipped due to a partial migration failure.
--       CHAR(64) → CHAR(64) is a no-op in MySQL.
--
-- Design:
--   All operations use SET @sql / PREPARE / EXECUTE or MODIFY COLUMN (idempotent).
--   Safe to run even when V001-V021 were already applied successfully.

-- ============================================================
-- 1. idx_usertab_account_status (V011 bare ADD INDEX guard)
-- ============================================================

SET @s = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'usertab'
      AND INDEX_NAME   = 'idx_usertab_account_status') = 0,
  'ALTER TABLE usertab ADD INDEX idx_usertab_account_status (account_status)',
  'SELECT 1 /* idx_usertab_account_status already exists */'
);
PREPARE _stmt FROM @s; EXECUTE _stmt; DEALLOCATE PREPARE _stmt;

-- ============================================================
-- 2. uq_memberstab_public_id (V017 bare CREATE UNIQUE INDEX guard)
-- ============================================================

-- Backfill public_id so the unique index can be created without duplicates.
UPDATE memberstab m
  INNER JOIN usertab u ON u.uid = m.uid
SET
  m.public_id    = COALESCE(NULLIF(m.public_id, ''),    NULLIF(u.public_uid, ''),    UUID()),
  m.referral_slug = COALESCE(NULLIF(m.referral_slug, ''), NULLIF(u.referral_slug, ''), LOWER(LEFT(REPLACE(UUID(), '-', ''), 16)))
WHERE
  m.public_id     IS NULL OR m.public_id     = ''
  OR m.referral_slug IS NULL OR m.referral_slug = '';

SET @s = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'memberstab'
      AND INDEX_NAME   = 'uq_memberstab_public_id') = 0,
  'CREATE UNIQUE INDEX uq_memberstab_public_id ON memberstab (public_id)',
  'SELECT 1 /* uq_memberstab_public_id already exists */'
);
PREPARE _stmt FROM @s; EXECUTE _stmt; DEALLOCATE PREPARE _stmt;

SET @s = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'memberstab'
      AND INDEX_NAME   = 'uq_memberstab_referral_slug') = 0,
  'CREATE UNIQUE INDEX uq_memberstab_referral_slug ON memberstab (referral_slug)',
  'SELECT 1 /* uq_memberstab_referral_slug already exists */'
);
PREPARE _stmt FROM @s; EXECUTE _stmt; DEALLOCATE PREPARE _stmt;

-- ============================================================
-- 3. pairing_ledgerstab.ledger_uid CHAR(64) safety repair
--    MODIFY COLUMN is idempotent: CHAR(64) → CHAR(64) is a no-op.
-- ============================================================

SET @s = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'pairing_ledgerstab') > 0,
  'ALTER TABLE pairing_ledgerstab MODIFY COLUMN ledger_uid CHAR(64) NOT NULL',
  'SELECT 1 /* pairing_ledgerstab does not exist yet; V021 will create it with CHAR(64) */'
);
PREPARE _stmt FROM @s; EXECUTE _stmt; DEALLOCATE PREPARE _stmt;
