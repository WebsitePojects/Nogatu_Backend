-- V023: Ranking — Sponsor-Tree Basis + Global Consumption Zeroing
--
-- Business rule changes (effective 2026-06-11):
--
--   1. POINT BASIS — Repurchase points for ranking count only from a member's
--      SPONSOR tree (the drefid chain), NOT from the binary tree.
--      Binary-spillover members (placed under you but not sponsored by you)
--      do NOT contribute repurchase points to your ranking total.
--
--   2. BOTTOM-UP RACE — Rank qualification is processed deepest-node-first.
--      A member at depth 10 who accumulates 10,000 sponsor-tree repurchase
--      points qualifies for Supervisor 1 before any of their uplines do.
--
--   3. ZERO-OUT ON ACHIEVEMENT — When a member achieves a rank, the repurchase
--      events that were consumed toward that rank are written to
--      rank_global_consumptiontab.  Ancestor members' rankable-event queries
--      filter out globally consumed events, so those points cannot be
--      double-counted up the chain.
--
-- This migration adds rank_global_consumptiontab to support rule #3.
-- The service layer changes (rankingRace.js + ranking.js) implement rules 1–3.

CREATE TABLE IF NOT EXISTS rank_global_consumptiontab (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repurchase_id        INT NOT NULL            COMMENT 'repurchasetab.id — the source repurchase event',
  source_member_uid    INT NOT NULL            COMMENT 'uid of the member whose repurchase is consumed',
  consuming_member_uid INT NOT NULL            COMMENT 'uid of the member whose rank achievement consumed this',
  consuming_rank_uid   CHAR(36) NOT NULL       COMMENT 'rank_achievementstab.achievement_uid',
  points_consumed      DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  consumed_at          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  -- One consumption record per (repurchase event, achieving member) pair.
  -- A single repurchase event can be partially consumed by different members
  -- (e.g. if it spans multiple rank achievements), but the SUM(points_consumed)
  -- must not exceed incentivepoints1 on the source row.
  UNIQUE KEY uq_repurchase_consumer (repurchase_id, consuming_member_uid),
  KEY idx_repurchase_id     (repurchase_id),
  KEY idx_consuming_member  (consuming_member_uid, consumed_at),
  KEY idx_source_member     (source_member_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
