-- V040: Admin-chosen display date for a news/memo post, independent of the upload
-- timestamp. So a memo dated "March 11" shows + sorts on March 11 even if uploaded
-- later. NULL falls back to created_at for legacy rows.

ALTER TABLE newstab
  ADD COLUMN IF NOT EXISTS post_date DATE NULL AFTER type;
