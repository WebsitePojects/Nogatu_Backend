-- V033: Allow 'unilevel' in rank_point_consumptiontab.source_leg.
--
-- The ranking engine's basis switched from the BINARY tree (left/right legs) to
-- the UNILEVEL/sponsor tree (V023), which has no left/right legs — so the race
-- gate writes source_leg = 'unilevel' (rankingRace.js). But the ENUM was created
-- for binary legs ('self','left','right','unknown') and never widened, so on a
-- strict-mode MySQL the consumption-ledger INSERT fails with
-- "Data truncated for column 'source_leg'" and rolls back the whole rank award.
--
-- Fix: append 'unilevel' to the ENUM (audit/display column only — point-locking
-- lives in rank_global_consumptiontab, which has no source_leg). Appending at the
-- END keeps existing values' ordinals 1..4 unchanged, so this is an INSTANT,
-- metadata-only ALTER (no table rebuild, safe on the live prod table).
ALTER TABLE rank_point_consumptiontab
  MODIFY COLUMN source_leg
    ENUM('self','left','right','unknown','unilevel') NOT NULL DEFAULT 'unilevel';
