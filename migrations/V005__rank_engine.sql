-- Versioned rank definitions and transparent point consumption.

CREATE TABLE IF NOT EXISTS rank_definitionstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  definition_uid CHAR(36) NOT NULL,
  rank_code VARCHAR(64) NOT NULL,
  rank_name VARCHAR(128) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  points_required DECIMAL(14,2) UNSIGNED NOT NULL,
  left_rank_required VARCHAR(64) NULL,
  right_rank_required VARCHAR(64) NULL,
  incentive_summary TEXT NOT NULL,
  cash_incentive DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  valid_from DATE NOT NULL,
  valid_until DATE NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_definition_uid (definition_uid),
  UNIQUE KEY uq_rank_version (rank_code, version),
  KEY idx_active_sort (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_achievementstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  achievement_uid CHAR(36) NOT NULL,
  member_uid INT NOT NULL,
  rank_definition_uid CHAR(36) NOT NULL,
  achieved_at TIMESTAMP(6) NOT NULL,
  sequence_id BIGINT UNSIGNED NOT NULL,
  gross_points_at_achievement DECIMAL(14,2) UNSIGNED NOT NULL DEFAULT 0,
  consumed_by_upline_points DECIMAL(14,2) UNSIGNED NOT NULL DEFAULT 0,
  remaining_rankable_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('pending_fulfillment','fulfilled','forfeited') NOT NULL DEFAULT 'pending_fulfillment',
  fulfilled_at TIMESTAMP(6) NULL,
  admin_fulfilled_by INT NULL,
  fulfillment_notes TEXT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_achievement_uid (achievement_uid),
  UNIQUE KEY uq_member_rank (member_uid, rank_definition_uid),
  KEY idx_member (member_uid, achieved_at),
  KEY idx_race (achieved_at, sequence_id),
  KEY idx_status (status, achieved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_point_consumptiontab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consumption_uid CHAR(36) NOT NULL,
  consumed_member_uid INT NOT NULL,
  consuming_rank_uid CHAR(36) NOT NULL,
  consuming_member_uid INT NOT NULL,
  points_consumed DECIMAL(14,2) UNSIGNED NOT NULL,
  consumed_at TIMESTAMP(6) NOT NULL,
  explanation TEXT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_consumption_uid (consumption_uid),
  KEY idx_consumed_member (consumed_member_uid, created_at),
  KEY idx_consuming_rank (consuming_rank_uid),
  KEY idx_consuming_member (consuming_member_uid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rank_sequence_countertab (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  next_sequence BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO rank_sequence_countertab (id, next_sequence) VALUES (1, 1);

INSERT INTO rank_definitionstab
  (definition_uid, rank_code, rank_name, version, points_required, left_rank_required, right_rank_required, incentive_summary, cash_incentive, sort_order, valid_from)
VALUES
  (UUID(), 'supervisor_1', 'Supervisor 1', 1, 10000, NULL, NULL, 'D.P Motorcycle, 5,000 Cash, White T-shirt', 5000, 10, '2026-05-06'),
  (UUID(), 'supervisor_2', 'Supervisor 2', 1, 20000, 'supervisor_1', 'supervisor_1', 'Laptop, 10,000 Cash, White Polo Shirt', 10000, 20, '2026-05-06'),
  (UUID(), 'supervisor_3', 'Supervisor 3', 1, 40000, 'supervisor_2', 'supervisor_2', 'International Asian Travel, 20,000 Cash, White polo shirt with red collar, Silver Pin', 20000, 30, '2026-05-06'),
  (UUID(), 'manager_1', 'Manager 1', 1, 60000, 'supervisor_3', 'supervisor_3', 'D.P Car Sedan, 30,000 Cash, Red T-Shirt', 30000, 40, '2026-05-06'),
  (UUID(), 'manager_2', 'Manager 2', 1, 100000, 'manager_1', 'manager_1', 'D.P Car SUV, 50,000 Cash, Red Polo Shirt', 50000, 50, '2026-05-06'),
  (UUID(), 'manager_3', 'Manager 3', 1, 200000, 'manager_2', 'manager_2', 'D.P Condo Unit, 100,000 Cash, Red Polo Shirt with Black Collar, Gold Pin', 100000, 60, '2026-05-06'),
  (UUID(), 'director_1', 'Director 1', 1, 600000, 'manager_3', 'manager_3', 'Sedan Full Payment, 200,000 Cash, Black Shirt', 200000, 70, '2026-05-06'),
  (UUID(), 'director_2', 'Director 2', 1, 1000000, 'director_1', 'director_1', 'SUV Full Payment, 300,000 Cash, Black Polo Shirt', 300000, 80, '2026-05-06'),
  (UUID(), 'director_3', 'Director 3', 1, 1600000, 'director_2', 'director_2', 'Condo Fully Paid, 500,000 Cash, Black Polo Shirt, Black Jacket, Ring', 500000, 90, '2026-05-06'),
  (UUID(), 'ambassador', 'AMBASSADOR', 1, 2000000, 'director_3', 'director_3', '1,000,000 Cash, Yellow Polo Shirt, White Jacket, 1 Pin and a Ring, US travel for 2, One point for global bonus', 1000000, 100, '2026-05-06')
ON DUPLICATE KEY UPDATE
  rank_name = VALUES(rank_name),
  points_required = VALUES(points_required),
  left_rank_required = VALUES(left_rank_required),
  right_rank_required = VALUES(right_rank_required),
  incentive_summary = VALUES(incentive_summary),
  cash_incentive = VALUES(cash_incentive),
  sort_order = VALUES(sort_order),
  is_active = 1;
