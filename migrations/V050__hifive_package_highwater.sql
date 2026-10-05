-- V050: Hi-Five package high-water.
-- A Hi-Five package set, once completed, stays earned even after the five directs upgrade out of
-- that tier (management policy, Upgrade Stranding Audit 2026-09-25). The engine counts directs at
-- their CURRENT package, so a completed set dissolved when a direct upgraded and the monotonic
-- credit silently absorbed the loss from the member's next set. This table keeps the highest
-- same-tier direct count ever observed per member; entitlement uses max(current, high_water).
-- Rows only ever grow (GREATEST on upsert). Numbered V050 so it cannot collide with the AR
-- migrations V047-V049 on the feat/ar-system branch.
CREATE TABLE IF NOT EXISTS hifive_package_highwatertab (
  uid INT NOT NULL,
  producttype SMALLINT UNSIGNED NOT NULL COMMENT 'package tier 10-60',
  high_water INT UNSIGNED NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'observed' COMMENT 'observed | stranding-correction-20260925',
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid, producttype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
