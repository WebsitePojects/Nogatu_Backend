-- NCDMS <-> MLM bridge: flag which members are NCDMS stockists.
-- NCDMS (nogatu.store dropshipping) users are all stockists; stockists earn their
-- own Portions in the global bonus, so the MLM must know which usertab rows are
-- stockists. Populated via POST /api/external/stockists/sync (NCDMS pushes its
-- stockist usernames). Run once on the VPS.
ALTER TABLE usertab ADD COLUMN stockist TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE usertab ADD INDEX idx_usertab_stockist (stockist);
