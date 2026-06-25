-- V040: Allow a customizable "memo date" for news posts. Admins set this in the
-- upload modal so the public News page shows the date printed on the memo/document
-- rather than the upload timestamp. NULL falls back to created_at at display time.

ALTER TABLE newstab
  ADD COLUMN IF NOT EXISTS display_date DATE NULL AFTER created_at;
