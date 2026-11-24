-- V052: Pairing carry reset (account ownership handover, Felix001 2026-11-24).
-- When an account changes hands, management wants the unmatched binary points (the "remaining PV"
-- carry) accumulated by the previous owner to never pay out to the new owner. The pairing engine
-- reads this table: binary points dated BEFORE carry_flush_day are matched as usual, but the carry
-- left over when the engine reaches carry_flush_day is discarded on both legs. Pairing already
-- earned before the cutoff is unchanged, so the monotonic ttlincome2 credit needs no baseline.
-- Engine days are the date part of usertab.datereg / upgradetab.transdate as stored (Node-era rows
-- are UTC, so an engine day starts at 08:00 Manila).
-- One row per member (PK). Rows are written only by a pinned, audited handover script.
CREATE TABLE IF NOT EXISTS pairing_carry_resettab (
  uid INT NOT NULL,
  carry_flush_day DATE NOT NULL COMMENT 'carry is discarded before the engine processes this day',
  carry_left_flushed BIGINT NOT NULL DEFAULT 0 COMMENT 'binary points discarded on the left leg',
  carry_right_flushed BIGINT NOT NULL DEFAULT 0 COMMENT 'binary points discarded on the right leg',
  reason VARCHAR(255) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
