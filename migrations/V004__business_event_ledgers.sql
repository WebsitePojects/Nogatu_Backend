-- Immutable audit/event ledgers for money, pairing, registration, ranking, and support.

CREATE TABLE IF NOT EXISTS audit_logtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_uid INT NULL,
  actor_role VARCHAR(32) NOT NULL DEFAULT 'system',
  action VARCHAR(128) NOT NULL,
  target_uid INT NULL,
  target_table VARCHAR(64) NULL,
  target_id VARCHAR(128) NULL,
  before_state JSON NULL,
  after_state JSON NULL,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  request_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_actor (actor_uid, created_at),
  KEY idx_target (target_uid, created_at),
  KEY idx_action (action, created_at),
  KEY idx_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS binary_point_eventstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid CHAR(36) NOT NULL,
  source_member_uid INT NOT NULL,
  owner_uid INT NULL,
  parent_uid INT NULL,
  leg ENUM('left','right','self','unknown') NOT NULL DEFAULT 'unknown',
  event_type ENUM('registration','package_upgrade','qualifying_code','product_purchase','manual_adjustment') NOT NULL,
  package_type VARCHAR(32) NULL,
  point_value DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  reference_key VARCHAR(128) NOT NULL,
  event_ts TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_uid (event_uid),
  UNIQUE KEY uq_reference_key (reference_key),
  KEY idx_source (source_member_uid, event_ts),
  KEY idx_owner_leg (owner_uid, leg, event_ts),
  KEY idx_parent (parent_uid, leg, event_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pairing_ledgerstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ledger_uid CHAR(36) NOT NULL,
  owner_uid INT NOT NULL,
  left_event_uid CHAR(36) NOT NULL,
  right_event_uid CHAR(36) NOT NULL,
  pair_points DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  pair_cap DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  points_used DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  income_event_uid CHAR(36) NULL,
  paired_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_uid (ledger_uid),
  KEY idx_owner (owner_uid, paired_at),
  KEY idx_income (income_event_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS income_eventstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid CHAR(36) NOT NULL,
  process_key VARCHAR(128) NOT NULL,
  beneficiary_uid INT NOT NULL,
  income_type VARCHAR(64) NOT NULL,
  source_ref_uid VARCHAR(128) NOT NULL,
  source_ref_type VARCHAR(64) NOT NULL,
  gross_amount DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  tax_deduction DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  processing_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  cd_deduction DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  maintenance_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  net_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('pending','credited','failed','reversed') NOT NULL DEFAULT 'pending',
  credited_at TIMESTAMP(6) NULL,
  reversed_at TIMESTAMP(6) NULL,
  reversal_reason TEXT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_uid (event_uid),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_beneficiary (beneficiary_uid, status, created_at),
  KEY idx_source (source_ref_uid, source_ref_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS encashmentstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  encashment_uid CHAR(36) NOT NULL,
  process_key VARCHAR(128) NOT NULL,
  beneficiary_uid INT NOT NULL,
  payouthistory_pid INT NULL,
  requested_amount DECIMAL(12,2) UNSIGNED NOT NULL,
  tax_amount DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  processing_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  cd_deduction DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  maintenance_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 20.00,
  net_payout DECIMAL(12,2) NOT NULL DEFAULT 0,
  payout_option_id INT NULL,
  payout_details_masked VARCHAR(255) NULL,
  status ENUM('submitted','approved','processing','paid','rejected','cancelled','reversed') NOT NULL DEFAULT 'submitted',
  request_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_encashment_uid (encashment_uid),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_beneficiary (beneficiary_uid, status, created_at),
  KEY idx_payouthistory (payouthistory_pid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS placement_lockstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lock_key VARCHAR(128) NOT NULL,
  locked_by_req VARCHAR(80) NOT NULL,
  locked_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lock_key (lock_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS support_ticketstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_uid CHAR(36) NOT NULL,
  member_uid INT NOT NULL,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(180) NULL,
  subject VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('open','in_review','resolved','closed') NOT NULL DEFAULT 'open',
  request_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_uid (ticket_uid),
  KEY idx_member (member_uid, created_at),
  KEY idx_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokenstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_uid INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  used_at TIMESTAMP(6) NULL,
  request_ip VARCHAR(45) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_member (member_uid, created_at),
  KEY idx_expiry (expires_at, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_queuetab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_key VARCHAR(128) NOT NULL,
  job_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('queued','processing','done','failed','cancelled') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  locked_at TIMESTAMP(6) NULL,
  locked_by VARCHAR(80) NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_key (job_key),
  KEY idx_status_available (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
