-- V025: Voucher product request and cashier claim lifecycle
--
-- Members/admins submit voucher product requests first. Cashiers later mark the
-- ER request as claimed after physically releasing the products.

ALTER TABLE voucher_availmentstab
  ADD COLUMN IF NOT EXISTS request_source VARCHAR(32) NOT NULL DEFAULT 'cashier' AFTER transaction_id,
  ADD COLUMN IF NOT EXISTS claim_status VARCHAR(32) NOT NULL DEFAULT 'requested' AFTER request_source,
  ADD COLUMN IF NOT EXISTS claimed_at DATETIME NULL AFTER claim_status,
  ADD COLUMN IF NOT EXISTS claimed_by_admin_id INT NULL AFTER claimed_at,
  ADD COLUMN IF NOT EXISTS claimed_by_admin VARCHAR(120) NULL AFTER claimed_by_admin_id,
  ADD KEY IF NOT EXISTS idx_voucher_availment_claim_status (claim_status, availment_date);

ALTER TABLE voucher_availment_itemstab
  ADD COLUMN IF NOT EXISTS product_code INT NULL AFTER line_no,
  ADD COLUMN IF NOT EXISTS product_key VARCHAR(32) NULL AFTER product_code,
  ADD KEY IF NOT EXISTS idx_voucher_availment_item_product (product_code);
