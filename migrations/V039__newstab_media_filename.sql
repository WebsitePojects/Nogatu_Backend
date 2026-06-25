-- V039: Remember the original upload filename for news media so downloads keep the
-- real name instead of Cloudinary's random public_id (which made downloads land as
-- "file.pdf"). Used to build a Cloudinary fl_attachment:<name> download URL.

ALTER TABLE newstab
  ADD COLUMN IF NOT EXISTS media_filename VARCHAR(255) NULL AFTER image_url;
