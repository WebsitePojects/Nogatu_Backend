-- V051: Voucher validity extension audit trail.
-- Admin "Extend validity" (management meeting 2026-11-10) replaces one-off extension scripts.
-- A voucher has TWO expiry clocks: expiry_date while unused (first_used_at IS NULL) and
-- use_expires_at after first use. Each extension records which clock it moved, the old and new
-- value, and the status transition (an expired voucher flips 2 -> 1 together with the new date).
-- Append-only: rows are never updated or deleted. No money column is referenced or written.
CREATE TABLE IF NOT EXISTS voucher_validity_extensiontab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voucher_id INT NOT NULL,
  uid INT NOT NULL,
  clock ENUM('unused','used') NOT NULL COMMENT 'unused = expiry_date, used = use_expires_at',
  old_expiry DATETIME NULL,
  new_expiry DATETIME NOT NULL,
  old_status INT NOT NULL,
  new_status INT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  admin_id INT NULL,
  admin_username VARCHAR(120) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_vve_voucher (voucher_id, created_at),
  KEY idx_vve_uid (uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
