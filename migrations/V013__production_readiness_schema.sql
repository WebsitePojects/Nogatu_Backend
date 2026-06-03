ALTER TABLE memberstab
  MODIFY COLUMN password VARCHAR(255) NULL;

ALTER TABLE accesstab
  MODIFY COLUMN password VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS referral_invitestab (
  id INT NOT NULL AUTO_INCREMENT,
  sponsor_uid INT NOT NULL,
  placement_uid INT NOT NULL,
  position TINYINT NOT NULL,
  token VARCHAR(80) NOT NULL,
  active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_referral_token (token),
  KEY idx_sponsor_active (sponsor_uid, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_messagestab (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(200) DEFAULT NULL,
  subject VARCHAR(255) DEFAULT NULL,
  message TEXT NOT NULL,
  status TINYINT NOT NULL DEFAULT 0,
  ip_address VARCHAR(45) DEFAULT NULL,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_blockedtab (
  id INT NOT NULL AUTO_INCREMENT,
  email VARCHAR(200) DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  reason VARCHAR(255) DEFAULT NULL,
  blocked_by VARCHAR(120) DEFAULT NULL,
  active TINYINT NOT NULL DEFAULT 1,
  blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email (email),
  KEY idx_ip_address (ip_address),
  KEY idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS newstab (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  type ENUM('news', 'announcement', 'promo', 'memo') DEFAULT 'news',
  image_url VARCHAR(500) DEFAULT NULL,
  is_published TINYINT(1) DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_published (is_published),
  INDEX idx_type (type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE newstab
  MODIFY COLUMN type ENUM('news', 'announcement', 'promo', 'memo') DEFAULT 'news';

CREATE TABLE IF NOT EXISTS distributor_applicationstab (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  age INT DEFAULT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(200) NOT NULL,
  letter_of_intent_url VARCHAR(500) DEFAULT NULL,
  letter_of_intent_public_id VARCHAR(255) DEFAULT NULL,
  letter_of_intent_filename VARCHAR(255) DEFAULT NULL,
  letter_of_intent_uploaded_at DATETIME DEFAULT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  follow_up_status ENUM('new', 'followed_up', 'cancelled', 'done') NOT NULL DEFAULT 'new',
  admin_note TEXT DEFAULT NULL,
  reviewed_by VARCHAR(100) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_email_phone (email, phone),
  KEY idx_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE distributor_applicationstab
  MODIFY COLUMN age INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS letter_of_intent_url VARCHAR(500) DEFAULT NULL AFTER email,
  ADD COLUMN IF NOT EXISTS letter_of_intent_public_id VARCHAR(255) DEFAULT NULL AFTER letter_of_intent_url,
  ADD COLUMN IF NOT EXISTS letter_of_intent_filename VARCHAR(255) DEFAULT NULL AFTER letter_of_intent_public_id,
  ADD COLUMN IF NOT EXISTS letter_of_intent_uploaded_at DATETIME DEFAULT NULL AFTER letter_of_intent_filename,
  ADD COLUMN IF NOT EXISTS follow_up_status ENUM('new', 'followed_up', 'cancelled', 'done') NOT NULL DEFAULT 'new' AFTER status;

CREATE TABLE IF NOT EXISTS finance_budget_columntab (
  id INT NOT NULL AUTO_INCREMENT,
  column_key VARCHAR(80) NOT NULL,
  label VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT NOT NULL DEFAULT 1,
  updated_by VARCHAR(120) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_finance_budget_column_key (column_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS finance_budget_column_valuestab (
  column_id INT NOT NULL,
  package_type INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_by VARCHAR(120) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (column_id, package_type),
  CONSTRAINT fk_finance_budget_value_column
    FOREIGN KEY (column_id) REFERENCES finance_budget_columntab (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO finance_package_coststab
  (package_type, product_cost, sales_match_ceiling, admin_extra_cost, notes, updated_by)
VALUES
  (10, 0, 0, 0, NULL, 'migration-V013'),
  (20, 0, 0, 0, NULL, 'migration-V013'),
  (30, 0, 40000, 0, NULL, 'migration-V013'),
  (40, 0, 80000, 0, NULL, 'migration-V013'),
  (50, 0, 160000, 0, NULL, 'migration-V013'),
  (60, 0, 160000, 0, NULL, 'migration-V013')
ON DUPLICATE KEY UPDATE
  sales_match_ceiling = IF(sales_match_ceiling = 0, VALUES(sales_match_ceiling), sales_match_ceiling);

CREATE TABLE IF NOT EXISTS globalbonus_poolstab (
  id INT NOT NULL AUTO_INCREMENT,
  period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month INT NOT NULL DEFAULT 0,
  period_year INT NOT NULL,
  total_net_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
  bonus_pool DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_portions INT NOT NULL DEFAULT 0,
  per_portion_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  status INT NOT NULL DEFAULT 0,
  distributed_date DATETIME DEFAULT NULL,
  created_date DATETIME DEFAULT NULL,
  processid VARCHAR(30) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_scope (period_scope, period_year, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE IF NOT EXISTS globalbonus_membertab (
  id INT NOT NULL AUTO_INCREMENT,
  uid INT NOT NULL,
  period_scope VARCHAR(16) NOT NULL DEFAULT 'annual',
  period_month INT NOT NULL DEFAULT 0,
  period_year INT NOT NULL,
  member_type VARCHAR(60) DEFAULT NULL,
  portions FLOAT NOT NULL DEFAULT 0,
  share_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  distributed_date DATETIME DEFAULT NULL,
  processid VARCHAR(30) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uid_scope_period (uid, period_scope, period_year, period_month),
  KEY idx_period_scope (period_scope, period_year, period_month),
  KEY idx_uid (uid)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

ALTER TABLE globalbonus_poolstab
  ADD COLUMN IF NOT EXISTS period_scope VARCHAR(16) NOT NULL DEFAULT 'annual' AFTER id,
  ADD COLUMN IF NOT EXISTS period_month INT NOT NULL DEFAULT 0 AFTER period_scope;

ALTER TABLE globalbonus_membertab
  ADD COLUMN IF NOT EXISTS period_scope VARCHAR(16) NOT NULL DEFAULT 'annual' AFTER uid,
  ADD COLUMN IF NOT EXISTS period_month INT NOT NULL DEFAULT 0 AFTER period_scope;

UPDATE globalbonus_poolstab
   SET period_scope = CASE
     WHEN COALESCE(period_month, 0) = 0 THEN 'annual'
     ELSE 'monthly'
   END
 WHERE period_scope IS NULL OR period_scope = '';

UPDATE globalbonus_membertab
   SET period_scope = CASE
     WHEN COALESCE(period_month, 0) = 0 THEN 'annual'
     ELSE 'monthly'
   END
 WHERE period_scope IS NULL OR period_scope = '';
