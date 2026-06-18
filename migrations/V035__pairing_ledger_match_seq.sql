-- Add a chronological match ordinal to the pairing ledger so the Pairing
-- History UI can show the very first matched pair first and let the
-- "source remaining" columns decrement monotonically — even when many pairs
-- share the same paired_at timestamp (a late-joining strong-leg source matched
-- against many earlier weak-leg sources all "form" at the same instant).
--
-- match_seq is the order each pair was consumed by buildPairingLedgerEntries
-- (both legs sorted by event time then event_uid), persisted per owner.
-- Idempotent: guarded by information_schema so re-running is a no-op.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'pairing_ledgerstab'
     AND COLUMN_NAME = 'match_seq'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE pairing_ledgerstab ADD COLUMN match_seq INT NULL AFTER paired_at',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'pairing_ledgerstab'
     AND INDEX_NAME = 'idx_pairing_owner_match_seq'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE pairing_ledgerstab ADD INDEX idx_pairing_owner_match_seq (owner_uid, match_seq)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
