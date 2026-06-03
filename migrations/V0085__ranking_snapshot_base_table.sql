-- Create the ranking snapshot table before later race-field extensions.
-- Some imported historical dumps do not contain rankingstab yet, so V009 must
-- never assume the table already exists.

CREATE TABLE IF NOT EXISTS rankingstab (
  uid INT NOT NULL,
  current_rank INT NOT NULL DEFAULT 0,
  rank_level INT NOT NULL DEFAULT 0,
  highest_rank_no INT NOT NULL DEFAULT 0,
  binary_points_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  basis_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  consumed_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  remaining_rankable_points DECIMAL(14,2) NOT NULL DEFAULT 0,
  basis_label VARCHAR(120) NOT NULL DEFAULT 'repurchase points',
  race_basis_mode VARCHAR(40) NOT NULL DEFAULT 'repurchase-event',
  rank_date DATETIME(6) DEFAULT NULL,
  race_last_awarded_at DATETIME(6) DEFAULT NULL,
  qualified_date DATETIME(6) DEFAULT NULL,
  left_qualified_count INT NOT NULL DEFAULT 0,
  right_qualified_count INT NOT NULL DEFAULT 0,
  incentive_status TINYINT NOT NULL DEFAULT 0,
  reward_status TINYINT NOT NULL DEFAULT 0,
  pending_achievement_count INT NOT NULL DEFAULT 0,
  reward_claimed_date DATETIME(6) DEFAULT NULL,
  last_calculated_at DATETIME(6) DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid),
  KEY idx_current_rank (current_rank),
  KEY idx_highest_rank_no (highest_rank_no),
  KEY idx_reward_status (reward_status),
  KEY idx_last_calculated_at (last_calculated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
