-- V032: Incremental repurchase-points aggregate (Phase 1, SHADOW mode).
--
-- Single source of truth for the leaderboard *points* column, maintained
-- incrementally instead of recomputing subtrees. remaining = gross - consumed.
--   gross    = Σ repurchase incentivepoints1 over the member's sponsor subtree (incl self)
--   consumed = Σ rank_global_consumptiontab points sourced from the member's subtree
--
-- SHADOW: this table is populated + kept current by the new propagation path but
-- does NOT yet drive the live leaderboard. It runs in parallel for reconciliation
-- against the existing engine before any display switch. Additive + idempotent.

CREATE TABLE IF NOT EXISTS member_rank_pointstab (
  member_uid      INT NOT NULL,
  gross_points    DECIMAL(16,2) NOT NULL DEFAULT 0,
  consumed_points DECIMAL(16,2) NOT NULL DEFAULT 0,
  -- remaining is derived (gross - consumed); stored generated col for fast ORDER BY.
  remaining_points DECIMAL(16,2) AS (GREATEST(0, gross_points - consumed_points)) STORED,
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (member_uid),
  KEY idx_remaining (remaining_points)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
