-- V045: auditable, durable AR keyed activation-code generation batches
CREATE TABLE IF NOT EXISTS code_generation_batchtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  idempotency_key VARCHAR(64) NOT NULL,
  actor_admin_id INT NOT NULL DEFAULT 0,
  actor_admin VARCHAR(120) NULL,
  ar_number VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  no_of_codes INT NOT NULL,
  product_type INT NOT NULL,
  code_type INT NOT NULL,
  stockist_id INT NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  codes_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_code_generation_batch_key (actor_admin_id, idempotency_key),
  KEY idx_code_generation_batch_ar (ar_number),
  KEY idx_code_generation_batch_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS code_generation_batch_codetab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  code_id INT NOT NULL,
  code VARCHAR(12) NOT NULL,
  ar_number VARCHAR(120) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_code_generation_batch_code (batch_id, code_id),
  KEY idx_code_generation_batch_code (code),
  CONSTRAINT fk_code_generation_batch_code_batch
    FOREIGN KEY (batch_id) REFERENCES code_generation_batchtab(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
