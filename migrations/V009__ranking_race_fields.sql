-- Extend the existing ranking foundation for race-based repurchase point awards.

ALTER TABLE rankingstab
  ADD COLUMN IF NOT EXISTS highest_rank_no INT NOT NULL DEFAULT 0 AFTER rank_level,
  ADD COLUMN IF NOT EXISTS consumed_points DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER basis_points,
  ADD COLUMN IF NOT EXISTS remaining_rankable_points DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER consumed_points,
  ADD COLUMN IF NOT EXISTS race_last_awarded_at DATETIME(6) DEFAULT NULL AFTER rank_date,
  ADD COLUMN IF NOT EXISTS race_basis_mode VARCHAR(40) NOT NULL DEFAULT 'repurchase-event' AFTER basis_label,
  ADD COLUMN IF NOT EXISTS pending_achievement_count INT NOT NULL DEFAULT 0 AFTER reward_status;

ALTER TABLE rank_achievementstab
  ADD COLUMN IF NOT EXISTS last_consumed_event_ts DATETIME(6) DEFAULT NULL AFTER achieved_at,
  ADD COLUMN IF NOT EXISTS tie_break_member_uid INT DEFAULT NULL AFTER last_consumed_event_ts,
  ADD COLUMN IF NOT EXISTS source_basis VARCHAR(40) NOT NULL DEFAULT 'repurchase-event' AFTER tie_break_member_uid;

ALTER TABLE rank_point_consumptiontab
  ADD COLUMN IF NOT EXISTS source_event_id BIGINT DEFAULT NULL AFTER points_consumed,
  ADD COLUMN IF NOT EXISTS source_event_ts DATETIME(6) DEFAULT NULL AFTER source_event_id,
  ADD COLUMN IF NOT EXISTS source_leg ENUM('self','left','right','unknown') NOT NULL DEFAULT 'unknown' AFTER source_event_ts,
  ADD COLUMN IF NOT EXISTS source_process_id VARCHAR(80) DEFAULT NULL AFTER source_leg;

ALTER TABLE rankingstab
  ADD INDEX IF NOT EXISTS idx_highest_rank_no (highest_rank_no),
  ADD INDEX IF NOT EXISTS idx_race_last_awarded_at (race_last_awarded_at);

ALTER TABLE rank_achievementstab
  ADD INDEX IF NOT EXISTS idx_member_status (member_uid, status, achieved_at),
  ADD INDEX IF NOT EXISTS idx_source_basis (source_basis, achieved_at);

ALTER TABLE rank_point_consumptiontab
  ADD INDEX IF NOT EXISTS idx_consuming_member_event (consuming_member_uid, source_event_id),
  ADD INDEX IF NOT EXISTS idx_source_event_ts (source_event_ts),
  ADD INDEX IF NOT EXISTS idx_consumed_member_event (consumed_member_uid, source_event_id);
