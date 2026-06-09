-- Add role column to accesstab to support readonly admin accounts.
-- role='admin' is the default (existing accounts are unaffected).
-- role='readonly' blocks all POST/PUT/PATCH/DELETE in the Node backend.

ALTER TABLE accesstab
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'admin'
    COMMENT 'admin | readonly';
