-- V042: idempotency keys for state-changing endpoints (multi-tap / retry dedupe).
-- Layer 2 of the double-submit defense: layer 1 is the per-row CAS
-- (`UPDATE ... WHERE codestatus = 1`) which makes double-pay impossible even
-- if this table is bypassed. This layer gives exactly-once semantics per
-- client action and replays the original response to duplicate submissions.
CREATE TABLE IF NOT EXISTS idempotency_keystab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  idem_key VARCHAR(64) NOT NULL,
  scope VARCHAR(64) NOT NULL,
  actor_uid INT NOT NULL DEFAULT 0,
  request_hash CHAR(64) DEFAULT NULL,
  status ENUM('processing','done') NOT NULL DEFAULT 'processing',
  response_code SMALLINT DEFAULT NULL,
  response_body MEDIUMTEXT DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at TIMESTAMP(6) NULL DEFAULT NULL,
  UNIQUE KEY uq_scope_actor_key (scope, actor_uid, idem_key),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
