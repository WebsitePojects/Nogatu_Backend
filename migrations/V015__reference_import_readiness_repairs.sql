ALTER TABLE memberstab
  MODIFY COLUMN email VARCHAR(180) NULL,
  MODIFY COLUMN contactnos VARCHAR(30) NULL,
  MODIFY COLUMN dob VARCHAR(30) NULL;

CREATE TABLE IF NOT EXISTS voucher_transactionstab (
  id INT NOT NULL AUTO_INCREMENT,
  uid INT NOT NULL,
  voucher_id INT NOT NULL,
  cash_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  voucher_used DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_voucher_tx_uid (uid, transaction_date),
  KEY idx_voucher_tx_voucher (voucher_id, transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
