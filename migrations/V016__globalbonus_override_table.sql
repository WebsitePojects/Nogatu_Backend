CREATE TABLE IF NOT EXISTS globalbonus_override_tab (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uid INT NOT NULL,
  period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month INT NOT NULL DEFAULT 0,
  period_year INT NOT NULL,
  status INT NOT NULL DEFAULT 1,
  manual_entry TINYINT(1) NOT NULL DEFAULT 0,
  portions FLOAT NOT NULL DEFAULT 0,
  member_type VARCHAR(60) DEFAULT NULL,
  created_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  processid VARCHAR(30) DEFAULT NULL,
  UNIQUE KEY uq_globalbonus_override_period_member (uid, period_scope, period_month, period_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
