-- V024: Manual voucher availment tracking for cashier/admin voucher management
--
-- Adds ER-based voucher usage logs with multi-line item tracking while preserving
-- the existing member-facing voucher redemption flow.

ALTER TABLE voucher_transactionstab
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(32) NULL AFTER total_value,
  ADD COLUMN IF NOT EXISTS availment_id BIGINT UNSIGNED NULL AFTER source_type,
  ADD COLUMN IF NOT EXISTS external_reference VARCHAR(120) NULL AFTER availment_id;

CREATE TABLE IF NOT EXISTS voucher_availmentstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voucher_id INT NOT NULL,
  uid INT NOT NULL,
  er_number VARCHAR(120) NOT NULL,
  availment_date DATETIME NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  transaction_id INT NULL,
  created_by_admin_id INT NULL,
  created_by_admin VARCHAR(120) NULL,
  updated_by_admin_id INT NULL,
  updated_by_admin VARCHAR(120) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_voucher_availment_voucher (voucher_id, availment_date),
  KEY idx_voucher_availment_uid (uid, availment_date),
  KEY idx_voucher_availment_er (er_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS voucher_availment_itemstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  availment_id BIGINT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL,
  item_label VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_availment_line (availment_id, line_no),
  KEY idx_voucher_availment_item_parent (availment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS voucher_availment_audittab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  availment_id BIGINT UNSIGNED NOT NULL,
  voucher_id INT NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  actor_admin_id INT NULL,
  actor_admin VARCHAR(120) NULL,
  snapshot_before JSON NULL,
  snapshot_after JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_voucher_availment_audit_parent (availment_id, created_at),
  KEY idx_voucher_availment_audit_voucher (voucher_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
