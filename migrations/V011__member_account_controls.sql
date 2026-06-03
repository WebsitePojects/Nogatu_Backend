ALTER TABLE usertab
  ADD COLUMN account_status VARCHAR(16) NOT NULL DEFAULT 'active' AFTER status,
  ADD COLUMN account_status_reason VARCHAR(500) DEFAULT NULL AFTER account_status,
  ADD COLUMN account_status_changed_at DATETIME DEFAULT NULL AFTER account_status_reason,
  ADD COLUMN account_status_changed_by INT DEFAULT NULL AFTER account_status_changed_at,
  ADD INDEX idx_usertab_account_status (account_status);

UPDATE usertab
   SET account_status = 'active'
 WHERE account_status IS NULL OR account_status = '';
