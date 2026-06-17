-- V034: Rank exclusion — flagged (company / system / main) accounts are blocked
-- from achieving any rank, so they can NEVER consume repurchase points from the
-- network (the global-consumption lock that would otherwise remove those points
-- permanently from real members). Admin flags these from the Unilevel Tree viewer.
--
-- Enforced in the ranking engine: an excluded member's award list is zeroed before
-- any consumption row is written, so their downline's points stay available to
-- legitimate uplines. Additive + idempotent.
CREATE TABLE IF NOT EXISTS rank_exclusionstab (
  uid          INT NOT NULL,
  reason       VARCHAR(255) NULL,
  excluded_by  INT NULL,                 -- admin uid who flagged it
  created_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
