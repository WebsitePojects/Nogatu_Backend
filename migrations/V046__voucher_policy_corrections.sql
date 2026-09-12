-- V046: CD voucher policy, immutable revocation history, and request repair audit.
-- Status 5 means revoked by policy. Revocation never deletes a voucher or changes cash.

ALTER TABLE voucherstab
  ADD COLUMN IF NOT EXISTS revoked_by VARCHAR(120) NULL AFTER revocation_reason;

ALTER TABLE voucher_availmentstab
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL AFTER claimed_by_admin,
  ADD COLUMN IF NOT EXISTS cancelled_by_admin_id INT NULL AFTER cancelled_at,
  ADD COLUMN IF NOT EXISTS cancelled_by_admin VARCHAR(120) NULL AFTER cancelled_by_admin_id,
  ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(500) NULL AFTER cancelled_by_admin;

CREATE TABLE IF NOT EXISTS voucher_revocation_audittab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id CHAR(36) NOT NULL,
  manifest_hash CHAR(64) NOT NULL,
  voucher_id INT NOT NULL,
  uid INT NOT NULL,
  package_type INT NOT NULL,
  remaining_balance DECIMAL(12,2) NOT NULL,
  voucher_status_before INT NOT NULL,
  effective_code_type VARCHAR(16) NOT NULL,
  reason VARCHAR(120) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_revocation_run_row (run_id, voucher_id),
  KEY idx_voucher_revocation_manifest (manifest_hash),
  KEY idx_voucher_revocation_uid (uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS voucher_request_correctiontab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  correction_key VARCHAR(160) NOT NULL,
  er_number VARCHAR(120) NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  availment_id BIGINT UNSIGNED NOT NULL,
  transaction_id INT NULL,
  uid INT NOT NULL,
  voucher_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  cash_refund DECIMAL(12,2) NOT NULL DEFAULT 0,
  voucher_refund DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(16) NULL,
  actor_admin VARCHAR(120) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_request_correction_key (correction_key),
  KEY idx_voucher_request_correction_er (er_number),
  KEY idx_voucher_request_correction_uid (uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
