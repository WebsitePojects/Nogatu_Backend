-- Phase 1 binary integrity schema:
-- - placement decision audit
-- - structured activation code lifecycle usage
-- - stronger public registration audit metadata
-- - member identity search indexes

CREATE TABLE IF NOT EXISTS binary_placement_audittab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sponsor_uid INT NOT NULL,
  placement_uid INT NOT NULL,
  created_uid INT NULL,
  requested_position TINYINT NULL,
  enforced_position TINYINT NOT NULL,
  policy_mode VARCHAR(32) NOT NULL,
  policy_reason VARCHAR(120) NOT NULL,
  referral_token VARCHAR(80) NULL,
  process_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_sponsor_created (sponsor_uid, created_at),
  KEY idx_created_uid (created_uid, created_at),
  KEY idx_placement_uid (placement_uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activation_code_usagetab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(80) NOT NULL,
  code_row_id INT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_uid INT NULL,
  to_uid INT NULL,
  actor_uid INT NULL,
  actor_admin_id INT NULL,
  referral_token VARCHAR(80) NULL,
  registration_uid INT NULL,
  upgrade_uid INT NULL,
  notes JSON NULL,
  process_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_activation_code_usage_process (process_key),
  KEY idx_code_created (code, created_at),
  KEY idx_event_type_created (event_type, created_at),
  KEY idx_registration_uid (registration_uid, created_at),
  KEY idx_upgrade_uid (upgrade_uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE memberstab
  ADD COLUMN IF NOT EXISTS tin VARCHAR(30) DEFAULT NULL AFTER middlename,
  ADD COLUMN IF NOT EXISTS email VARCHAR(180) DEFAULT NULL AFTER payoutid,
  ADD COLUMN IF NOT EXISTS contactnos VARCHAR(30) DEFAULT NULL AFTER email,
  ADD COLUMN IF NOT EXISTS dob VARCHAR(30) DEFAULT NULL AFTER gender;

ALTER TABLE public_registration_audittab
  ADD COLUMN IF NOT EXISTS requested_position TINYINT NULL AFTER activation_code,
  ADD COLUMN IF NOT EXISTS enforced_position TINYINT NULL AFTER requested_position,
  ADD COLUMN IF NOT EXISTS placement_policy_mode VARCHAR(32) NULL AFTER enforced_position,
  ADD COLUMN IF NOT EXISTS placement_policy_reason VARCHAR(120) NULL AFTER placement_policy_mode,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP(6) NULL AFTER status;

ALTER TABLE public_registration_audittab
  ADD INDEX IF NOT EXISTS idx_registration_status_created (status, created_at);

ALTER TABLE memberstab
  ADD INDEX IF NOT EXISTS idx_memberstab_email (email),
  ADD INDEX IF NOT EXISTS idx_memberstab_contactnos (contactnos),
  ADD INDEX IF NOT EXISTS idx_memberstab_dob (dob),
  ADD INDEX IF NOT EXISTS idx_memberstab_tin (tin);
