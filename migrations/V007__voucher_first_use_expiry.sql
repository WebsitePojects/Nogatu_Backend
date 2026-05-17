-- Voucher expiry remains aligned with the business rule: countdown starts at first use.

CREATE TABLE IF NOT EXISTS voucherstab (
  id INT NOT NULL AUTO_INCREMENT,
  uid INT NOT NULL,
  package_type INT NOT NULL,
  voucher_amount DECIMAL(12,2) NOT NULL,
  remaining_balance DECIMAL(12,2) NOT NULL,
  issued_date DATETIME NOT NULL,
  expiry_date DATETIME NULL,
  status INT NOT NULL DEFAULT 1,
  redeemed_date DATETIME DEFAULT NULL,
  suspend_reason VARCHAR(500) DEFAULT NULL,
  suspended_by VARCHAR(120) DEFAULT NULL,
  suspended_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_uid (uid),
  KEY idx_status (status),
  KEY idx_expiry_date (expiry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE voucherstab ADD COLUMN first_used_at DATETIME NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucherstab' AND COLUMN_NAME = 'first_used_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE voucherstab ADD COLUMN use_expires_at DATETIME NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucherstab' AND COLUMN_NAME = 'use_expires_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE voucherstab ADD COLUMN revoked_at DATETIME NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucherstab' AND COLUMN_NAME = 'revoked_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE voucherstab ADD COLUMN revocation_reason VARCHAR(500) NULL',
    'SELECT 1')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucherstab' AND COLUMN_NAME = 'revocation_reason'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
