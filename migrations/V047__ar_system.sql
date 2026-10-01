-- V047: AR (Acknowledgement Receipt) system — cashier receipts, approval, and code release.
-- Spec: documentations/AR_SYSTEM_SPEC_2026-10-01.md (NogatuMLM root).
-- Additive only. Reference rows seeded here are REAL data (the two centers from the management
-- form, Dino's stockist package-discount table). Prices and the AR number seed are deliberately NOT
-- seeded: prices are set by Super Admin, and the sequence stays unset until Super Admin enters the
-- latest paper AR number, so no invented value can ever reach production through a migration.

CREATE TABLE IF NOT EXISTS ar_centertab (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(8) NOT NULL,
  name VARCHAR(80) NOT NULL,
  address VARCHAR(255) NULL,
  contact_person VARCHAR(120) NULL,
  contact_number VARCHAR(40) NULL,
  operating_hours VARCHAR(80) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ar_center_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO ar_centertab (code, name, address, contact_person, contact_number, operating_hours) VALUES
  ('CAL', 'Caloocan', '94 Navarro St., Maligaya Park Subdivision, Brgy. 177, Caloocan City',
   'Cecilia Haspe', '0286639946', '11:00 AM - 7:00 PM'),
  ('TYC', 'Tycoon', 'Tycoon Center Bldg., Unit 2201, Pearl Drive, San Antonio, Ortigas Center, Pasig',
   'Dino S. Erfe', '0286594254', '1:30 PM - 7:30 PM');

-- A cashier is bound to exactly one center; every AR they prepare is stamped with it.
ALTER TABLE accesstab ADD COLUMN IF NOT EXISTS ar_center_id INT UNSIGNED NULL;

-- One global numeric sequence shared by all centers. Single row (id = 1). next_seq stays NULL until
-- Super Admin seeds it; AR creation refuses while it is NULL. Numbers are taken under
-- SELECT ... FOR UPDATE inside the AR's own transaction, so no two ARs can ever share one.
CREATE TABLE IF NOT EXISTS ar_sequencetab (
  id TINYINT UNSIGNED NOT NULL,
  next_seq BIGINT UNSIGNED NULL,
  seeded_from BIGINT UNSIGNED NULL,
  seeded_by VARCHAR(60) NULL,
  seeded_at TIMESTAMP NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO ar_sequencetab (id, next_seq) VALUES (1, NULL);

-- AR-only stockist registry. Deliberately NOT usertab.stockistid: that column drives Global Bonus
-- portions (services/globalBonus.js), and on 2026-10-01 it was 1 for all 7,822 members. Tagging
-- stockists there would silently change Global Bonus eligibility.
CREATE TABLE IF NOT EXISTS ar_stockisttab (
  uid INT NOT NULL,
  stockist_type TINYINT UNSIGNED NOT NULL COMMENT '2 = Mobile, 3 = City, 4 = Provincial',
  set_by VARCHAR(60) NULL,
  set_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid),
  KEY idx_ar_stockist_type (stockist_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Price list: one row per sellable producttype (10-60 packages, 100-109 products).
CREATE TABLE IF NOT EXISTS ar_price_listtab (
  producttype INT NOT NULL,
  item_name VARCHAR(120) NOT NULL,
  member_price DECIMAL(12,2) NOT NULL,
  stockist_price DECIMAL(12,2) NOT NULL,
  srp DECIMAL(12,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(60) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (producttype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Peso discount per package, per stockist type. Packages only; never stacks with member pricing.
CREATE TABLE IF NOT EXISTS ar_stockist_discounttab (
  stockist_type TINYINT UNSIGNED NOT NULL,
  producttype INT NOT NULL,
  peso_discount DECIMAL(12,2) NOT NULL,
  updated_by VARCHAR(60) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (stockist_type, producttype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Dino's table, 2026-09-19 (PHP per package). Stockist types: 4 Provincial, 3 City, 2 Mobile.
INSERT IGNORE INTO ar_stockist_discounttab (stockist_type, producttype, peso_discount) VALUES
  (4, 10, 100.00), (4, 20, 200.00), (4, 30, 500.00), (4, 40, 1000.00), (4, 50, 1750.00), (4, 60, 4000.00),
  (3, 10,  75.00), (3, 20, 150.00), (3, 30, 250.00), (3, 40,  600.00), (3, 50, 1250.00), (3, 60, 3000.00),
  (2, 10,  50.00), (2, 20, 100.00), (2, 30, 200.00), (2, 40,  400.00), (2, 50,  750.00), (2, 60, 2000.00);

CREATE TABLE IF NOT EXISTS ar_receipttab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ar_no VARCHAR(20) NOT NULL COMMENT 'digits only',
  ar_year SMALLINT UNSIGNED NOT NULL,
  ar_seq BIGINT UNSIGNED NULL COMMENT 'NULL for legacy ARs, which keep their paper number in ar_no',
  center_id INT UNSIGNED NOT NULL,
  mode ENUM('package','cash_member','cash_stockist','cash_srp','voucher') NOT NULL,
  status ENUM('pending_approval','completed','void') NOT NULL,
  is_legacy TINYINT(1) NOT NULL DEFAULT 0,
  legacy_date DATE NULL,
  buyer_uid INT NULL,
  buyer_name VARCHAR(160) NOT NULL,
  recipient_uid INT NULL COMMENT 'account that receives generated codes',
  stockist_type TINYINT UNSIGNED NULL COMMENT 'snapshot of the buyer''s stockist type when priced',
  subtotal DECIMAL(12,2) NOT NULL,
  discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL,
  payment_method ENUM('cash','gcash','bdo','psbank','other_bank','voucher') NOT NULL,
  payment_ref VARCHAR(120) NULL,
  notes VARCHAR(500) NULL,
  prepared_by_admin_id INT NOT NULL,
  prepared_by VARCHAR(60) NOT NULL,
  released_by VARCHAR(120) NULL COMMENT 'optional; person who physically handed over the items',
  approved_by_admin_id INT NULL,
  approved_by VARCHAR(60) NULL,
  void_reason VARCHAR(255) NULL,
  voided_by VARCHAR(60) NULL,
  release_error VARCHAR(255) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  approved_at TIMESTAMP(6) NULL,
  voided_at TIMESTAMP(6) NULL,
  print_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ar_no (ar_no),
  KEY idx_ar_status_created (status, created_at),
  KEY idx_ar_center_created (center_id, created_at),
  KEY idx_ar_buyer (buyer_uid, created_at),
  KEY idx_ar_prepared (prepared_by_admin_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ar_itemtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ar_id BIGINT UNSIGNED NOT NULL,
  producttype INT NOT NULL,
  description VARCHAR(160) NOT NULL,
  qty INT UNSIGNED NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL COMMENT 'snapshot at creation; price edits never alter past ARs',
  discount_each DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL,
  generates_codes TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ar_item_ar (ar_id),
  CONSTRAINT fk_ar_item_receipt FOREIGN KEY (ar_id) REFERENCES ar_receipttab(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A code belongs to at most one AR (UNIQUE code_id): the release can never hand one code out twice.
CREATE TABLE IF NOT EXISTS ar_code_linktab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ar_id BIGINT UNSIGNED NOT NULL,
  ar_item_id BIGINT UNSIGNED NOT NULL,
  code_id INT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ar_code (code_id),
  KEY idx_ar_code_ar (ar_id),
  CONSTRAINT fk_ar_code_receipt FOREIGN KEY (ar_id) REFERENCES ar_receipttab(id),
  CONSTRAINT fk_ar_code_item FOREIGN KEY (ar_item_id) REFERENCES ar_itemtab(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One audit trail for every AR-side change: approvals, voids, price/discount/stockist/seed edits.
CREATE TABLE IF NOT EXISTS ar_audittab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(40) NOT NULL,
  action VARCHAR(40) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  actor_admin_id INT NULL,
  actor VARCHAR(60) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_ar_audit_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
