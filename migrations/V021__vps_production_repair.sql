-- V021: VPS Production Database Repair
--
-- Purpose:
--   Catch-all safety net for all tables and columns the Node.js backend
--   requires that may be missing from a raw PHP production dump import.
--
-- Design:
--   Every CREATE TABLE uses IF NOT EXISTS.
--   Every ADD COLUMN uses IF NOT EXISTS.
--   Every index guard uses the SET @sql / PREPARE / EXECUTE pattern.
--   Every data seed uses INSERT IGNORE or ON DUPLICATE KEY UPDATE.
--   Safe to run even when V001–V020 were already applied successfully.
--
-- Sections:
--   1. Session store
--   2. CRITICAL — audit tables (500 errors without these)
--   3. Registration audit
--   4. Binary tree closure
--   5. Business event ledgers
--   6. Rank engine
--   7. Hifive / voucher / referral
--   8. Finance config
--   9. Communication tables
--  10. Ranking tables
--  11. Column repairs on existing tables
--  12. Index safety repairs
--  13. Data seeds and backfills

-- ============================================================
-- 1. SESSION STORE (needed for backend startup)
-- ============================================================

CREATE TABLE IF NOT EXISTS app_sessions (
  session_id  VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ============================================================
-- 2. CRITICAL AUDIT TABLES
--    appendActivationCodeUsage() and appendPlacementAudit() INSERT
--    into these on every code op and every registration.
--    Missing = HTTP 500 on those endpoints.
-- ============================================================

CREATE TABLE IF NOT EXISTS activation_code_usagetab (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(80) NOT NULL,
  code_row_id    INT NULL,
  event_type     VARCHAR(32) NOT NULL,
  from_uid       INT NULL,
  to_uid         INT NULL,
  actor_uid      INT NULL,
  actor_admin_id INT NULL,
  referral_token VARCHAR(80) NULL,
  registration_uid INT NULL,
  upgrade_uid    INT NULL,
  notes          JSON NULL,
  process_key    VARCHAR(128) NOT NULL,
  created_at     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_activation_code_usage_process (process_key),
  KEY idx_code_created (code, created_at),
  KEY idx_event_type_created (event_type, created_at),
  KEY idx_registration_uid (registration_uid, created_at),
  KEY idx_upgrade_uid (upgrade_uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS binary_placement_audittab (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sponsor_uid        INT NOT NULL,
  placement_uid      INT NOT NULL,
  created_uid        INT NULL,
  requested_position TINYINT NULL,
  enforced_position  TINYINT NOT NULL,
  policy_mode        VARCHAR(32) NOT NULL,
  policy_reason      VARCHAR(120) NOT NULL,
  referral_token     VARCHAR(80) NULL,
  process_key        VARCHAR(128) NOT NULL,
  created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_sponsor_created (sponsor_uid, created_at),
  KEY idx_created_uid (created_uid, created_at),
  KEY idx_placement_uid (placement_uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 3. REGISTRATION AUDIT
-- ============================================================

CREATE TABLE IF NOT EXISTS public_registration_audittab (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  registration_uid       CHAR(36) NOT NULL,
  sponsor_uid            INT NOT NULL,
  new_member_uid         INT NULL,
  referral_slug          VARCHAR(32) NOT NULL,
  activation_code        VARCHAR(80) NULL,
  requested_position     TINYINT NULL,
  enforced_position      TINYINT NULL,
  placement_policy_mode  VARCHAR(32) NULL,
  placement_policy_reason VARCHAR(120) NULL,
  registration_ip        VARCHAR(45) NULL,
  device_fingerprint     VARCHAR(256) NULL,
  status                 ENUM('started','approved','rejected','completed') NOT NULL DEFAULT 'started',
  suspicious_flags       JSON NULL,
  consumed_at            TIMESTAMP(6) NULL,
  created_at             TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_uid (registration_uid),
  KEY idx_registration_status_created (status, created_at),
  KEY idx_sponsor (sponsor_uid, created_at),
  KEY idx_new_member (new_member_uid),
  KEY idx_slug (referral_slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hifive_qualificationstab (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  qualification_uid CHAR(36) NOT NULL,
  member_uid       INT NOT NULL,
  hifive_type      ENUM('package','product') NOT NULL,
  trigger_event_uid VARCHAR(128) NOT NULL,
  package_or_product VARCHAR(120) NOT NULL,
  qualifying_count INT UNSIGNED NOT NULL DEFAULT 0,
  status           ENUM('pending_review','approved','paid','forfeited') NOT NULL DEFAULT 'pending_review',
  suspicious_flags JSON NULL,
  admin_notes      TEXT NULL,
  created_at       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_qualification_uid (qualification_uid),
  UNIQUE KEY uq_hifive_trigger (member_uid, hifive_type, trigger_event_uid),
  KEY idx_member_status (member_uid, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sponsor_placement_settingstab (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sponsor_uid    INT NOT NULL,
  placement_mode ENUM('balanced','left','right','manual') NOT NULL DEFAULT 'balanced',
  updated_at     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sponsor_uid (sponsor_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS referral_invitestab (
  id          INT NOT NULL AUTO_INCREMENT,
  sponsor_uid INT NOT NULL,
  placement_uid INT NOT NULL,
  position    TINYINT NOT NULL,
  token       VARCHAR(80) NOT NULL,
  active      TINYINT NOT NULL DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_referral_token (token),
  KEY idx_sponsor_active (sponsor_uid, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 4. BINARY TREE CLOSURE
-- ============================================================

CREATE TABLE IF NOT EXISTS binary_tree_closuretab (
  ancestor_uid   INT NOT NULL,
  descendant_uid INT NOT NULL,
  depth          INT UNSIGNED NOT NULL,
  leg            ENUM('left','right','self') NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ancestor_uid, descendant_uid),
  KEY idx_descendant (descendant_uid, ancestor_uid),
  KEY idx_ancestor_depth (ancestor_uid, depth),
  KEY idx_ancestor_leg_depth (ancestor_uid, leg, depth)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed self-links and direct binary links (INSERT IGNORE is safe on repeated runs)
INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT uid, uid, 0, 'self'
FROM usertab
WHERE uid IS NOT NULL;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT refid, uid, 1, CASE WHEN position = 1 THEN 'left' ELSE 'right' END
FROM usertab
WHERE refid IS NOT NULL AND refid > 0 AND uid IS NOT NULL AND uid <> refid;

-- Expand closure paths up to depth 30 (repeated passes converge safely)
INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

-- ============================================================
-- 5. BUSINESS EVENT LEDGERS
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logtab (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_uid    INT NULL,
  actor_role   VARCHAR(32) NOT NULL DEFAULT 'system',
  action       VARCHAR(128) NOT NULL,
  target_uid   INT NULL,
  target_table VARCHAR(64) NULL,
  target_id    VARCHAR(128) NULL,
  before_state JSON NULL,
  after_state  JSON NULL,
  ip_address   VARCHAR(45) NULL,
  user_agent   TEXT NULL,
  request_id   VARCHAR(80) NOT NULL,
  created_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_actor (actor_uid, created_at),
  KEY idx_target (target_uid, created_at),
  KEY idx_action (action, created_at),
  KEY idx_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS binary_point_eventstab (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid         CHAR(36) NOT NULL,
  source_member_uid INT NOT NULL,
  owner_uid         INT NULL,
  parent_uid        INT NULL,
  leg               ENUM('left','right','self','unknown') NOT NULL DEFAULT 'unknown',
  event_type        ENUM('registration','package_upgrade','qualifying_code','product_purchase','manual_adjustment') NOT NULL,
  package_type      VARCHAR(32) NULL,
  point_value       DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  reference_key     VARCHAR(128) NOT NULL,
  event_ts          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at        TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_uid (event_uid),
  UNIQUE KEY uq_reference_key (reference_key),
  KEY idx_source (source_member_uid, event_ts),
  KEY idx_owner_leg (owner_uid, leg, event_ts),
  KEY idx_parent (parent_uid, leg, event_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ledger_uid is CHAR(64) — createProcessKey() returns a 64-char SHA-256 hex string.
-- V004 created this as CHAR(36); V020 widened it. This definition starts correct.
CREATE TABLE IF NOT EXISTS pairing_ledgerstab (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ledger_uid      CHAR(64) NOT NULL,
  owner_uid       INT NOT NULL,
  left_event_uid  CHAR(36) NOT NULL,
  right_event_uid CHAR(36) NOT NULL,
  pair_points     DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  pair_cap        DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  points_used     DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  income_event_uid CHAR(36) NULL,
  paired_at       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_uid (ledger_uid),
  KEY idx_owner (owner_uid, paired_at),
  KEY idx_income (income_event_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- If the table was already created by V004 with CHAR(36), widen it to CHAR(64).
ALTER TABLE pairing_ledgerstab
  MODIFY COLUMN ledger_uid CHAR(64) NOT NULL;

CREATE TABLE IF NOT EXISTS income_eventstab (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid        CHAR(36) NOT NULL,
  process_key      VARCHAR(128) NOT NULL,
  beneficiary_uid  INT NOT NULL,
  income_type      VARCHAR(64) NOT NULL,
  source_ref_uid   VARCHAR(128) NOT NULL,
  source_ref_type  VARCHAR(64) NOT NULL,
  gross_amount     DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  tax_deduction    DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  processing_fee   DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  cd_deduction     DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  maintenance_fee  DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  net_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  status           ENUM('pending','credited','failed','reversed') NOT NULL DEFAULT 'pending',
  credited_at      TIMESTAMP(6) NULL,
  reversed_at      TIMESTAMP(6) NULL,
  reversal_reason  TEXT NULL,
  created_at       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_uid (event_uid),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_beneficiary (beneficiary_uid, status, created_at),
  KEY idx_source (source_ref_uid, source_ref_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS encashmentstab (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  encashment_uid        CHAR(36) NOT NULL,
  process_key           VARCHAR(128) NOT NULL,
  beneficiary_uid       INT NOT NULL,
  payouthistory_pid     INT NULL,
  requested_amount      DECIMAL(12,2) UNSIGNED NOT NULL,
  tax_amount            DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  processing_fee        DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  cd_deduction          DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  maintenance_fee       DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 20.00,
  net_payout            DECIMAL(12,2) NOT NULL DEFAULT 0,
  payout_option_id      INT NULL,
  payout_details_masked VARCHAR(255) NULL,
  status                ENUM('submitted','approved','processing','paid','rejected','cancelled','reversed') NOT NULL DEFAULT 'submitted',
  request_id            VARCHAR(80) NOT NULL,
  created_at            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_encashment_uid (encashment_uid),
  UNIQUE KEY uq_process_key (process_key),
  KEY idx_beneficiary (beneficiary_uid, status, created_at),
  KEY idx_payouthistory (payouthistory_pid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS placement_lockstab (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lock_key     VARCHAR(128) NOT NULL,
  locked_by_req VARCHAR(80) NOT NULL,
  locked_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at   DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lock_key (lock_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS support_ticketstab (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_uid CHAR(36) NOT NULL,
  member_uid INT NOT NULL,
  name       VARCHAR(160) NOT NULL,
  email      VARCHAR(180) NULL,
  subject    VARCHAR(180) NOT NULL,
  message    TEXT NOT NULL,
  status     ENUM('open','in_review','resolved','closed') NOT NULL DEFAULT 'open',
  request_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_uid (ticket_uid),
  KEY idx_member (member_uid, created_at),
  KEY idx_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokenstab (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_uid INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  used_at    TIMESTAMP(6) NULL,
  request_ip VARCHAR(45) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_member (member_uid, created_at),
  KEY idx_expiry (expires_at, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_queuetab (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_key     VARCHAR(128) NOT NULL,
  job_type    VARCHAR(64) NOT NULL,
  payload     JSON NOT NULL,
  status      ENUM('queued','processing','done','failed','cancelled') NOT NULL DEFAULT 'queued',
  attempts    INT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  locked_at   TIMESTAMP(6) NULL,
  locked_by   VARCHAR(80) NULL,
  last_error  TEXT NULL,
  created_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_key (job_key),
  KEY idx_status_available (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 6. RANK ENGINE
-- ============================================================

CREATE TABLE IF NOT EXISTS rank_definitionstab (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  definition_uid      CHAR(36) NOT NULL,
  rank_code           VARCHAR(64) NOT NULL,
  rank_name           VARCHAR(128) NOT NULL,
  version             INT UNSIGNED NOT NULL DEFAULT 1,
  points_required     DECIMAL(14,2) UNSIGNED NOT NULL,
  left_rank_required  VARCHAR(64) NULL,
  right_rank_required VARCHAR(64) NULL,
  incentive_summary   TEXT NOT NULL,
  cash_incentive      DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  sort_order          INT UNSIGNED NOT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  valid_from          DATE NOT NULL,
  valid_until         DATE NULL,
  created_at          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_definition_uid (definition_uid),
  UNIQUE KEY uq_rank_version (rank_code, version),
  KEY idx_active_sort (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_achievementstab (
  id                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  achievement_uid             CHAR(36) NOT NULL,
  member_uid                  INT NOT NULL,
  rank_definition_uid         CHAR(36) NOT NULL,
  achieved_at                 TIMESTAMP(6) NOT NULL,
  last_consumed_event_ts      DATETIME(6) DEFAULT NULL,
  tie_break_member_uid        INT DEFAULT NULL,
  source_basis                VARCHAR(40) NOT NULL DEFAULT 'repurchase-event',
  sequence_id                 BIGINT UNSIGNED NOT NULL,
  gross_points_at_achievement DECIMAL(14,2) UNSIGNED NOT NULL DEFAULT 0,
  consumed_by_upline_points   DECIMAL(14,2) UNSIGNED NOT NULL DEFAULT 0,
  remaining_rankable_points   DECIMAL(14,2) NOT NULL DEFAULT 0,
  status                      ENUM('pending_fulfillment','fulfilled','forfeited') NOT NULL DEFAULT 'pending_fulfillment',
  fulfilled_at                TIMESTAMP(6) NULL,
  admin_fulfilled_by          INT NULL,
  fulfillment_notes           TEXT NULL,
  created_at                  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_achievement_uid (achievement_uid),
  UNIQUE KEY uq_member_rank (member_uid, rank_definition_uid),
  KEY idx_member (member_uid, achieved_at),
  KEY idx_race (achieved_at, sequence_id),
  KEY idx_status (status, achieved_at),
  KEY idx_member_status (member_uid, status, achieved_at),
  KEY idx_source_basis (source_basis, achieved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_point_consumptiontab (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consumption_uid       CHAR(36) NOT NULL,
  consumed_member_uid   INT NOT NULL,
  consuming_rank_uid    CHAR(36) NOT NULL,
  consuming_member_uid  INT NOT NULL,
  points_consumed       DECIMAL(14,2) UNSIGNED NOT NULL,
  source_event_id       BIGINT DEFAULT NULL,
  source_event_ts       DATETIME(6) DEFAULT NULL,
  source_leg            ENUM('self','left','right','unknown') NOT NULL DEFAULT 'unknown',
  source_process_id     VARCHAR(80) DEFAULT NULL,
  consumed_at           TIMESTAMP(6) NOT NULL,
  explanation           TEXT NOT NULL,
  created_at            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_consumption_uid (consumption_uid),
  KEY idx_consumed_member (consumed_member_uid, created_at),
  KEY idx_consuming_rank (consuming_rank_uid),
  KEY idx_consuming_member (consuming_member_uid, created_at),
  KEY idx_consuming_member_event (consuming_member_uid, source_event_id),
  KEY idx_source_event_ts (source_event_ts),
  KEY idx_consumed_member_event (consumed_member_uid, source_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_sequence_countertab (
  id            TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  next_sequence BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO rank_sequence_countertab (id, next_sequence) VALUES (1, 1);

-- ============================================================
-- 7. VOUCHERS
-- ============================================================

CREATE TABLE IF NOT EXISTS voucherstab (
  id                INT NOT NULL AUTO_INCREMENT,
  uid               INT NOT NULL,
  package_type      INT NOT NULL,
  voucher_amount    DECIMAL(12,2) NOT NULL,
  remaining_balance DECIMAL(12,2) NOT NULL,
  issued_date       DATETIME NOT NULL,
  expiry_date       DATETIME NULL,
  first_used_at     DATETIME NULL,
  use_expires_at    DATETIME NULL,
  revoked_at        DATETIME NULL,
  revocation_reason VARCHAR(500) NULL,
  status            INT NOT NULL DEFAULT 1,
  redeemed_date     DATETIME DEFAULT NULL,
  suspend_reason    VARCHAR(500) DEFAULT NULL,
  suspended_by      VARCHAR(120) DEFAULT NULL,
  suspended_at      DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_uid (uid),
  KEY idx_status (status),
  KEY idx_expiry_date (expiry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- In case the table was created by V007 without the revoke/use-expiry columns:
ALTER TABLE voucherstab
  ADD COLUMN IF NOT EXISTS first_used_at     DATETIME NULL,
  ADD COLUMN IF NOT EXISTS use_expires_at    DATETIME NULL,
  ADD COLUMN IF NOT EXISTS revoked_at        DATETIME NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS voucher_transactionstab (
  id               INT NOT NULL AUTO_INCREMENT,
  uid              INT NOT NULL,
  voucher_id       INT NOT NULL,
  cash_paid        DECIMAL(12,2) NOT NULL DEFAULT 0,
  voucher_used     DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_value      DECIMAL(12,2) NOT NULL DEFAULT 0,
  transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_voucher_tx_uid (uid, transaction_date),
  KEY idx_voucher_tx_voucher (voucher_id, transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 8. FINANCE CONFIG
-- ============================================================

CREATE TABLE IF NOT EXISTS finance_package_coststab (
  package_type       INT NOT NULL,
  product_cost       DECIMAL(12,2) NOT NULL DEFAULT 0,
  sales_match_ceiling DECIMAL(12,2) NOT NULL DEFAULT 0,
  admin_extra_cost   DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes              VARCHAR(255) DEFAULT NULL,
  updated_by         VARCHAR(120) DEFAULT NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (package_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO finance_package_coststab
  (package_type, product_cost, sales_match_ceiling, admin_extra_cost, notes, updated_by)
VALUES
  (10, 0,  0,       0, NULL, 'V021-repair'),
  (20, 0,  0,       0, NULL, 'V021-repair'),
  (30, 0,  40000,   0, NULL, 'V021-repair'),
  (40, 0,  80000,   0, NULL, 'V021-repair'),
  (50, 0,  160000,  0, NULL, 'V021-repair'),
  (60, 0,  160000,  0, NULL, 'V021-repair')
ON DUPLICATE KEY UPDATE
  sales_match_ceiling = IF(sales_match_ceiling = 0, VALUES(sales_match_ceiling), sales_match_ceiling);

CREATE TABLE IF NOT EXISTS finance_budget_columntab (
  id         INT NOT NULL AUTO_INCREMENT,
  column_key VARCHAR(80) NOT NULL,
  label      VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active     TINYINT NOT NULL DEFAULT 1,
  updated_by VARCHAR(120) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_finance_budget_column_key (column_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS finance_budget_column_valuestab (
  column_id    INT NOT NULL,
  package_type INT NOT NULL,
  amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_by   VARCHAR(120) DEFAULT NULL,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (column_id, package_type),
  CONSTRAINT fk_finance_budget_value_column
    FOREIGN KEY (column_id) REFERENCES finance_budget_columntab (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 9. COMMUNICATION TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS newstab (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  content      TEXT NOT NULL,
  type         ENUM('news','announcement','promo','memo') DEFAULT 'news',
  image_url    VARCHAR(500) DEFAULT NULL,
  is_published TINYINT(1) DEFAULT 1,
  created_by   INT DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_published (is_published),
  INDEX idx_type (type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contact_messagestab (
  id           INT NOT NULL AUTO_INCREMENT,
  name         VARCHAR(150) NOT NULL,
  email        VARCHAR(200) DEFAULT NULL,
  subject      VARCHAR(255) DEFAULT NULL,
  message      TEXT NOT NULL,
  status       TINYINT NOT NULL DEFAULT 0,
  ip_address   VARCHAR(45) DEFAULT NULL,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_blockedtab (
  id         INT NOT NULL AUTO_INCREMENT,
  email      VARCHAR(200) DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  reason     VARCHAR(255) DEFAULT NULL,
  blocked_by VARCHAR(120) DEFAULT NULL,
  active     TINYINT NOT NULL DEFAULT 1,
  blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email (email),
  KEY idx_ip_address (ip_address),
  KEY idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS distributor_applicationstab (
  id                          INT NOT NULL AUTO_INCREMENT,
  name                        VARCHAR(150) NOT NULL,
  age                         INT DEFAULT NULL,
  phone                       VARCHAR(50) NOT NULL,
  email                       VARCHAR(200) NOT NULL,
  letter_of_intent_url        VARCHAR(500) DEFAULT NULL,
  letter_of_intent_public_id  VARCHAR(255) DEFAULT NULL,
  letter_of_intent_filename   VARCHAR(255) DEFAULT NULL,
  letter_of_intent_uploaded_at DATETIME DEFAULT NULL,
  status                      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  follow_up_status            ENUM('new','followed_up','cancelled','done') NOT NULL DEFAULT 'new',
  admin_note                  TEXT DEFAULT NULL,
  reviewed_by                 VARCHAR(100) DEFAULT NULL,
  reviewed_at                 DATETIME DEFAULT NULL,
  ip_address                  VARCHAR(45) DEFAULT NULL,
  submitted_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_email_phone (email, phone),
  KEY idx_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 10. GLOBAL BONUS
-- ============================================================

CREATE TABLE IF NOT EXISTS globalbonus_poolstab (
  id              INT NOT NULL AUTO_INCREMENT,
  period_scope    VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month    INT NOT NULL DEFAULT 0,
  period_year     INT NOT NULL,
  total_net_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
  bonus_pool      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_portions  INT NOT NULL DEFAULT 0,
  per_portion_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          INT NOT NULL DEFAULT 0,
  distributed_date DATETIME DEFAULT NULL,
  created_date    DATETIME DEFAULT NULL,
  processid       VARCHAR(30) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_scope (period_scope, period_year, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

ALTER TABLE globalbonus_poolstab
  ADD COLUMN IF NOT EXISTS period_scope  VARCHAR(16) NOT NULL DEFAULT 'annual',
  ADD COLUMN IF NOT EXISTS period_month  INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS globalbonus_membertab (
  id               INT NOT NULL AUTO_INCREMENT,
  uid              INT NOT NULL,
  period_scope     VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month     INT NOT NULL DEFAULT 0,
  period_year      INT NOT NULL,
  member_type      VARCHAR(60) DEFAULT NULL,
  portions         FLOAT NOT NULL DEFAULT 0,
  share_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  distributed_date DATETIME DEFAULT NULL,
  processid        VARCHAR(30) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uid_scope_period (uid, period_scope, period_year, period_month),
  KEY idx_period_scope (period_scope, period_year, period_month),
  KEY idx_uid (uid)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

ALTER TABLE globalbonus_membertab
  ADD COLUMN IF NOT EXISTS period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
  ADD COLUMN IF NOT EXISTS period_month INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS globalbonus_override_tab (
  id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uid          INT NOT NULL,
  period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month INT NOT NULL DEFAULT 0,
  period_year  INT NOT NULL,
  status       INT NOT NULL DEFAULT 1,
  manual_entry TINYINT(1) NOT NULL DEFAULT 0,
  portions     FLOAT NOT NULL DEFAULT 0,
  member_type  VARCHAR(60) DEFAULT NULL,
  created_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  processid    VARCHAR(30) DEFAULT NULL,
  UNIQUE KEY uq_globalbonus_override_period_member (uid, period_scope, period_month, period_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 11. RANKING TABLES (complete schema with all V009 columns)
-- ============================================================

CREATE TABLE IF NOT EXISTS rankingstab (
  uid                       INT NOT NULL,
  current_rank              INT NOT NULL DEFAULT 0,
  rank_level                INT NOT NULL DEFAULT 0,
  highest_rank_no           INT NOT NULL DEFAULT 0,
  binary_points_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  basis_points              DECIMAL(14,2) NOT NULL DEFAULT 0,
  consumed_points           DECIMAL(14,2) NOT NULL DEFAULT 0,
  remaining_rankable_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  basis_label               VARCHAR(120) NOT NULL DEFAULT 'repurchase points',
  race_basis_mode           VARCHAR(40) NOT NULL DEFAULT 'repurchase-event',
  rank_date                 DATETIME(6) DEFAULT NULL,
  race_last_awarded_at      DATETIME(6) DEFAULT NULL,
  qualified_date            DATETIME(6) DEFAULT NULL,
  left_qualified_count      INT NOT NULL DEFAULT 0,
  right_qualified_count     INT NOT NULL DEFAULT 0,
  incentive_status          TINYINT NOT NULL DEFAULT 0,
  reward_status             TINYINT NOT NULL DEFAULT 0,
  pending_achievement_count INT NOT NULL DEFAULT 0,
  reward_claimed_date       DATETIME(6) DEFAULT NULL,
  last_calculated_at        DATETIME(6) DEFAULT NULL,
  created_at                TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at                TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid),
  KEY idx_current_rank (current_rank),
  KEY idx_highest_rank_no (highest_rank_no),
  KEY idx_reward_status (reward_status),
  KEY idx_last_calculated_at (last_calculated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- In case rankingstab was created by the 001_sync script (older layout) —
-- add any missing columns introduced in V0085 / V009:
ALTER TABLE rankingstab
  ADD COLUMN IF NOT EXISTS highest_rank_no           INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consumed_points           DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_rankable_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS race_last_awarded_at      DATETIME(6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS race_basis_mode           VARCHAR(40) NOT NULL DEFAULT 'repurchase-event',
  ADD COLUMN IF NOT EXISTS pending_achievement_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at                TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6);

-- ============================================================
-- 12. COLUMN REPAIRS ON EXISTING TABLES
-- ============================================================

-- memberstab: widen password for bcrypt hashes
ALTER TABLE memberstab
  MODIFY COLUMN password VARCHAR(255) NULL,
  MODIFY COLUMN address  VARCHAR(255) NULL,
  MODIFY COLUMN email    VARCHAR(180) NULL,
  MODIFY COLUMN contactnos VARCHAR(30) NULL,
  MODIFY COLUMN dob      VARCHAR(30) NULL;

-- accesstab: widen password for bcrypt
ALTER TABLE accesstab
  MODIFY COLUMN password VARCHAR(255) NULL;

-- accesstab: add role column (V018 / V019)
ALTER TABLE accesstab
  ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'admin'
    COMMENT 'administrator | cashier | bod | readonly';

-- memberstab: tin column (V010)
ALTER TABLE memberstab
  ADD COLUMN IF NOT EXISTS tin          VARCHAR(30)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS public_id    CHAR(36)     NULL,
  ADD COLUMN IF NOT EXISTS referral_slug VARCHAR(32) NULL;

-- usertab: public identity columns (V002)
ALTER TABLE usertab
  ADD COLUMN IF NOT EXISTS public_uid    CHAR(36)    NULL,
  ADD COLUMN IF NOT EXISTS referral_slug VARCHAR(32) NULL;

-- usertab: account control columns (V011 / V019)
ALTER TABLE usertab
  ADD COLUMN IF NOT EXISTS account_status             VARCHAR(16)  NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS account_status_reason      VARCHAR(500) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS account_status_changed_at  DATETIME     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS account_status_changed_by  INT          DEFAULT NULL;

-- public_registration_audittab: phase-1 binary integrity columns (V010)
ALTER TABLE public_registration_audittab
  ADD COLUMN IF NOT EXISTS requested_position      TINYINT NULL,
  ADD COLUMN IF NOT EXISTS enforced_position       TINYINT NULL,
  ADD COLUMN IF NOT EXISTS placement_policy_mode   VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS placement_policy_reason VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS consumed_at             TIMESTAMP(6) NULL;

-- rank_achievementstab: race fields (V009)
ALTER TABLE rank_achievementstab
  ADD COLUMN IF NOT EXISTS last_consumed_event_ts DATETIME(6)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tie_break_member_uid   INT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_basis           VARCHAR(40)  NOT NULL DEFAULT 'repurchase-event';

-- rank_point_consumptiontab: race fields (V009)
ALTER TABLE rank_point_consumptiontab
  ADD COLUMN IF NOT EXISTS source_event_id  BIGINT       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_event_ts  DATETIME(6)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_leg       ENUM('self','left','right','unknown') NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_process_id VARCHAR(80) DEFAULT NULL;

-- ============================================================
-- 13. INDEX SAFETY REPAIRS
-- ============================================================

-- usertab public identity unique indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usertab' AND INDEX_NAME='uq_usertab_public_uid') = 0,
  'CREATE UNIQUE INDEX uq_usertab_public_uid ON usertab (public_uid)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usertab' AND INDEX_NAME='uq_usertab_referral_slug') = 0,
  'CREATE UNIQUE INDEX uq_usertab_referral_slug ON usertab (referral_slug)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- usertab account_status index
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usertab' AND INDEX_NAME='idx_usertab_account_status') = 0,
  'ALTER TABLE usertab ADD INDEX idx_usertab_account_status (account_status)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- memberstab public identity unique indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberstab' AND INDEX_NAME='uq_memberstab_public_id') = 0,
  'CREATE UNIQUE INDEX uq_memberstab_public_id ON memberstab (public_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberstab' AND INDEX_NAME='uq_memberstab_referral_slug') = 0,
  'CREATE UNIQUE INDEX uq_memberstab_referral_slug ON memberstab (referral_slug)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- memberstab identity indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberstab' AND INDEX_NAME='idx_memberstab_email') = 0,
  'ALTER TABLE memberstab ADD INDEX idx_memberstab_email (email)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberstab' AND INDEX_NAME='idx_memberstab_contactnos') = 0,
  'ALTER TABLE memberstab ADD INDEX idx_memberstab_contactnos (contactnos)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberstab' AND INDEX_NAME='idx_memberstab_tin') = 0,
  'ALTER TABLE memberstab ADD INDEX idx_memberstab_tin (tin)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- public_registration_audittab registration_status_created index
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_registration_audittab' AND INDEX_NAME='idx_registration_status_created') = 0,
  'ALTER TABLE public_registration_audittab ADD INDEX idx_registration_status_created (status, created_at)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rank_achievementstab race indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rank_achievementstab' AND INDEX_NAME='idx_member_status') = 0,
  'ALTER TABLE rank_achievementstab ADD INDEX idx_member_status (member_uid, status, achieved_at)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rank_achievementstab' AND INDEX_NAME='idx_source_basis') = 0,
  'ALTER TABLE rank_achievementstab ADD INDEX idx_source_basis (source_basis, achieved_at)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rank_point_consumptiontab race indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rank_point_consumptiontab' AND INDEX_NAME='idx_consuming_member_event') = 0,
  'ALTER TABLE rank_point_consumptiontab ADD INDEX idx_consuming_member_event (consuming_member_uid, source_event_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rank_point_consumptiontab' AND INDEX_NAME='idx_source_event_ts') = 0,
  'ALTER TABLE rank_point_consumptiontab ADD INDEX idx_source_event_ts (source_event_ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rank_point_consumptiontab' AND INDEX_NAME='idx_consumed_member_event') = 0,
  'ALTER TABLE rank_point_consumptiontab ADD INDEX idx_consumed_member_event (consumed_member_uid, source_event_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rankingstab race indexes
SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rankingstab' AND INDEX_NAME='idx_highest_rank_no') = 0,
  'ALTER TABLE rankingstab ADD INDEX idx_highest_rank_no (highest_rank_no)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rankingstab' AND INDEX_NAME='idx_race_last_awarded_at') = 0,
  'ALTER TABLE rankingstab ADD INDEX idx_race_last_awarded_at (race_last_awarded_at)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- 14. DATA SEEDS AND BACKFILLS
-- ============================================================

-- Seed rank definitions (idempotent via ON DUPLICATE KEY)
INSERT INTO rank_definitionstab
  (definition_uid, rank_code, rank_name, version, points_required,
   left_rank_required, right_rank_required, incentive_summary,
   cash_incentive, sort_order, valid_from)
VALUES
  (UUID(), 'supervisor_1', 'Supervisor 1', 1, 10000, NULL, NULL,
   'D.P Motorcycle, 5,000 Cash, White T-shirt', 5000, 10, '2026-05-06'),
  (UUID(), 'supervisor_2', 'Supervisor 2', 1, 20000, 'supervisor_1', 'supervisor_1',
   'Laptop, 10,000 Cash, White Polo Shirt', 10000, 20, '2026-05-06'),
  (UUID(), 'supervisor_3', 'Supervisor 3', 1, 40000, 'supervisor_2', 'supervisor_2',
   'International Asian Travel, 20,000 Cash, White polo shirt with red collar, Silver Pin', 20000, 30, '2026-05-06'),
  (UUID(), 'manager_1', 'Manager 1', 1, 60000, 'supervisor_3', 'supervisor_3',
   'D.P Car Sedan, 30,000 Cash, Red T-Shirt', 30000, 40, '2026-05-06'),
  (UUID(), 'manager_2', 'Manager 2', 1, 100000, 'manager_1', 'manager_1',
   'D.P Car SUV, 50,000 Cash, Red Polo Shirt', 50000, 50, '2026-05-06'),
  (UUID(), 'manager_3', 'Manager 3', 1, 200000, 'manager_2', 'manager_2',
   'D.P Condo Unit, 100,000 Cash, Red Polo Shirt with Black Collar, Gold Pin', 100000, 60, '2026-05-06'),
  (UUID(), 'director_1', 'Director 1', 1, 600000, 'manager_3', 'manager_3',
   'Sedan Full Payment, 200,000 Cash, Black Shirt', 200000, 70, '2026-05-06'),
  (UUID(), 'director_2', 'Director 2', 1, 1000000, 'director_1', 'director_1',
   'SUV Full Payment, 300,000 Cash, Black Polo Shirt', 300000, 80, '2026-05-06'),
  (UUID(), 'director_3', 'Director 3', 1, 1600000, 'director_2', 'director_2',
   'Condo Fully Paid, 500,000 Cash, Black Polo Shirt, Black Jacket, Ring', 500000, 90, '2026-05-06'),
  (UUID(), 'ambassador', 'AMBASSADOR', 1, 2000000, 'director_3', 'director_3',
   '1,000,000 Cash, Yellow Polo Shirt, White Jacket, 1 Pin and a Ring, US travel for 2, One point for global bonus',
   1000000, 100, '2026-05-06')
ON DUPLICATE KEY UPDATE
  rank_name        = VALUES(rank_name),
  points_required  = VALUES(points_required),
  left_rank_required  = VALUES(left_rank_required),
  right_rank_required = VALUES(right_rank_required),
  incentive_summary   = VALUES(incentive_summary),
  cash_incentive   = VALUES(cash_incentive),
  sort_order       = VALUES(sort_order),
  is_active        = 1;

-- Backfill usertab public identity (safe on repeated runs)
UPDATE usertab SET public_uid    = UUID()
  WHERE public_uid IS NULL OR public_uid = '';
UPDATE usertab SET referral_slug = LOWER(LEFT(REPLACE(UUID(), '-', ''), 16))
  WHERE referral_slug IS NULL OR referral_slug = '';

-- Backfill memberstab public identity from usertab
UPDATE memberstab m
INNER JOIN usertab u ON u.uid = m.uid
SET
  m.public_id    = COALESCE(NULLIF(m.public_id, ''),    NULLIF(u.public_uid, ''),    UUID()),
  m.referral_slug = COALESCE(NULLIF(m.referral_slug, ''), NULLIF(u.referral_slug, ''), LOWER(LEFT(REPLACE(UUID(), '-', ''), 16)))
WHERE
  m.public_id IS NULL OR m.public_id = ''
  OR m.referral_slug IS NULL OR m.referral_slug = '';

-- Backfill usertab account_status
UPDATE usertab SET account_status = 'active'
  WHERE account_status IS NULL OR account_status = '';

-- Seed accesstab roles from rights level (V019 parity)
UPDATE accesstab SET role = 'administrator' WHERE rights = 1 AND (role IS NULL OR role IN ('', 'admin'));
UPDATE accesstab SET role = 'cashier'       WHERE rights = 2 AND (role IS NULL OR role IN ('', 'admin'));
UPDATE accesstab SET role = 'bod'           WHERE rights = 3 AND (role IS NULL OR role IN ('', 'admin'));

SELECT 'V021 production repair complete.' AS status;
