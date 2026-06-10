-- V020: Widen pairing_ledgerstab.ledger_uid from CHAR(36) to CHAR(64).
--
-- Root cause: pairing_ledgerstab was created (V004) with ledger_uid CHAR(36)
-- (UUID-sized), but syncPairingLedger generates ledger_uid via createProcessKey()
-- which returns a 64-character SHA-256 hex string.  Every call to syncPairingLedger
-- was throwing ER_DATA_TOO_LONG (errno 1406) and causing HTTP 500 on the pairing
-- report page and admin income-details view.
--
-- Fix: widen to CHAR(64) to match SHA-256 output length.
-- The UNIQUE KEY on ledger_uid is preserved automatically.
-- This ALTER is idempotent: CHAR(64) → CHAR(64) is a no-op in MySQL.

ALTER TABLE pairing_ledgerstab
  MODIFY COLUMN ledger_uid CHAR(64) NOT NULL;
