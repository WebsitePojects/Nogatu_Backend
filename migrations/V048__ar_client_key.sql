-- V048: one AR per cashier intent.
-- The idempotency middleware lets a request without a key through, so a double tap could take two
-- AR numbers for one payment. The create path now requires a key and stores it here; the UNIQUE
-- index turns a repeat into a lookup of the first AR. Legacy ARs carry no key (NULLs never collide)
-- and stay deduplicated by their unique paper ar_no.
ALTER TABLE ar_receipttab
  ADD COLUMN IF NOT EXISTS client_key VARCHAR(64) NULL COMMENT 'Idempotency-Key of the create request' AFTER prepared_by,
  ADD UNIQUE KEY IF NOT EXISTS uq_ar_client_key (prepared_by_admin_id, client_key);
