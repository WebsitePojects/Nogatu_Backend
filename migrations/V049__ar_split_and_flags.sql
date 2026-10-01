-- V049: split orders and cashier flags for ARs.
-- Split: an order above one AR's 500-code limit is saved as consecutive ARs sharing split_group
-- (the create request's key); split_part/split_count label them "Part 1 of N".
-- Flags: a cashier marks a completed AR as having a mistake; a Super Admin voids it or keeps it.
-- open_ar_id equals ar_id while the flag is open and is NULL once resolved, so the UNIQUE index
-- allows one OPEN flag per AR while keeping every resolved flag as history.
ALTER TABLE ar_receipttab
  ADD COLUMN IF NOT EXISTS split_group VARCHAR(64) NULL COMMENT 'create key shared by every part of a split order' AFTER client_key,
  ADD COLUMN IF NOT EXISTS split_part TINYINT UNSIGNED NULL AFTER split_group,
  ADD COLUMN IF NOT EXISTS split_count TINYINT UNSIGNED NULL AFTER split_part,
  ADD KEY IF NOT EXISTS idx_ar_split (prepared_by_admin_id, split_group);

CREATE TABLE IF NOT EXISTS ar_flagtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ar_id BIGINT UNSIGNED NOT NULL,
  open_ar_id BIGINT UNSIGNED NULL COMMENT 'ar_id while open, NULL once resolved',
  reason VARCHAR(500) NOT NULL,
  raised_by_admin_id INT NOT NULL,
  raised_by VARCHAR(60) NOT NULL,
  raised_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  resolution ENUM('kept','voided') NULL,
  resolution_note VARCHAR(500) NULL,
  resolved_by_admin_id INT NULL,
  resolved_by VARCHAR(60) NULL,
  resolved_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ar_flag_open (open_ar_id),
  KEY idx_ar_flag_ar (ar_id),
  CONSTRAINT fk_ar_flag_receipt FOREIGN KEY (ar_id) REFERENCES ar_receipttab(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
