-- V037: atomic, idempotent product-point ranking processing and durable SSE outbox.
-- Additive and safe to run while the existing ranking reader remains online.

CREATE TABLE IF NOT EXISTS ranking_event_processstab (
  repurchase_id INT NOT NULL,
  source_member_uid INT NOT NULL,
  points DECIMAL(16,2) NOT NULL,
  process_key VARCHAR(120) NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  affected_member_count INT UNSIGNED NOT NULL DEFAULT 0,
  started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at TIMESTAMP(6) NULL,
  PRIMARY KEY (repurchase_id),
  UNIQUE KEY uq_ranking_event_process_key (process_key),
  KEY idx_ranking_event_source (source_member_uid, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ranking_realtime_outboxtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid CHAR(36) NOT NULL,
  repurchase_id INT NOT NULL,
  affected_member_uids LONGTEXT NOT NULL,
  status ENUM('pending','publishing','published') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at TIMESTAMP(6) NULL,
  last_error VARCHAR(1000) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ranking_outbox_event (event_uid),
  UNIQUE KEY uq_ranking_outbox_repurchase (repurchase_id),
  KEY idx_ranking_outbox_pending (status, available_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
