-- V041: Payment method for a cashier/admin voucher availment.
--   'wallet' = deduct the member's e-wallet (existing behavior).
--   'cash'   = member paid in cash at the office → voucher is still consumed, but the
--              e-wallet is NOT deducted (and is not even required). This supports
--              office walk-ins where the member has no/low balance.
-- Default 'wallet' keeps every existing row + caller unchanged.

ALTER TABLE voucher_availmentstab
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16) NOT NULL DEFAULT 'wallet'
    COMMENT 'wallet | cash' AFTER total_amount;
