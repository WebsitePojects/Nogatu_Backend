-- V037: per-account leadership credit forgiveness offset.
-- When > 0, the income engine shifts the monotonic leadership guard by this fixed amount:
--   newLeadership = MAX(0, engineEntitlement - ttlincome3 + leadership_credit_offset)
-- This lets a specific account whose paid ttlincome3 already exceeds its current engine
-- entitlement resume earning leadership on FORWARD growth, without re-crediting already-paid
-- amounts (idempotent: at steady state ttlincome3 = engine + offset, a fixed bound).
-- DEFAULT 0 => behaviour is unchanged for every account that does not have an offset set.
ALTER TABLE payouttotaltab
  ADD COLUMN IF NOT EXISTS leadership_credit_offset DECIMAL(15,2) NOT NULL DEFAULT 0;
