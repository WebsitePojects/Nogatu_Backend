-- V019: Widen role column to VARCHAR(50) and seed proper role names by rights level.
--
-- Background: V018 added `role VARCHAR(20) DEFAULT 'admin'`.  The VPS was manually
-- patched to VARCHAR(50) with values 'administrator', 'cashier', 'bod'.  This
-- migration makes the schema authoritative and idempotent on any environment.
--
-- Role semantics:
--   administrator  rights=1  full access (same as legacy 'admin')
--   cashier        rights=2  code release + transfer only; cannot generate codes
--   bod            rights=3  full access (same as administrator)
--   readonly       any       GET-only guard; blocks all write operations
--
-- This migration is safe to run even when the VPS manual patch is already applied.

ALTER TABLE accesstab
  MODIFY COLUMN role VARCHAR(50) NOT NULL DEFAULT 'admin'
    COMMENT 'administrator | cashier | bod | readonly';

-- Seed role values for accounts still carrying the V018 default 'admin'.
-- Accounts already set to 'administrator'/'cashier'/'bod'/'readonly' are not touched.
UPDATE accesstab SET role = 'administrator' WHERE rights = 1 AND role = 'admin';
UPDATE accesstab SET role = 'cashier'       WHERE rights = 2 AND role = 'admin';
UPDATE accesstab SET role = 'bod'           WHERE rights = 3 AND role = 'admin';

-- Repair: ensure V011 columns exist with IF NOT EXISTS so fresh environments
-- that were set up after manual column additions don't fail on V011.
ALTER TABLE usertab
  ADD COLUMN IF NOT EXISTS account_status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS account_status_reason   VARCHAR(500) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS account_status_changed_at DATETIME   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS account_status_changed_by INT        DEFAULT NULL;

UPDATE usertab
   SET account_status = 'active'
 WHERE account_status IS NULL OR account_status = '';
