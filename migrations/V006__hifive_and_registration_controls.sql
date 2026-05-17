CREATE TABLE IF NOT EXISTS hifive_qualificationstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  qualification_uid CHAR(36) NOT NULL,
  member_uid INT NOT NULL,
  hifive_type ENUM('package','product') NOT NULL,
  trigger_event_uid VARCHAR(128) NOT NULL,
  package_or_product VARCHAR(120) NOT NULL,
  qualifying_count INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('pending_review','approved','paid','forfeited') NOT NULL DEFAULT 'pending_review',
  suspicious_flags JSON NULL,
  admin_notes TEXT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_qualification_uid (qualification_uid),
  UNIQUE KEY uq_hifive_trigger (member_uid, hifive_type, trigger_event_uid),
  KEY idx_member_status (member_uid, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sponsor_placement_settingstab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sponsor_uid INT NOT NULL,
  placement_mode ENUM('balanced','left','right','manual') NOT NULL DEFAULT 'balanced',
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sponsor_uid (sponsor_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS public_registration_audittab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  registration_uid CHAR(36) NOT NULL,
  sponsor_uid INT NOT NULL,
  new_member_uid INT NULL,
  referral_slug VARCHAR(32) NOT NULL,
  activation_code VARCHAR(80) NULL,
  registration_ip VARCHAR(45) NULL,
  device_fingerprint VARCHAR(256) NULL,
  status ENUM('started','approved','rejected','completed') NOT NULL DEFAULT 'started',
  suspicious_flags JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_uid (registration_uid),
  KEY idx_sponsor (sponsor_uid, created_at),
  KEY idx_new_member (new_member_uid),
  KEY idx_slug (referral_slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
