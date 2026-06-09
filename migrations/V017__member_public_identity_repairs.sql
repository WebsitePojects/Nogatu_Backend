ALTER TABLE memberstab
  ADD COLUMN IF NOT EXISTS public_id CHAR(36) NULL AFTER uid,
  ADD COLUMN IF NOT EXISTS referral_slug VARCHAR(32) NULL AFTER public_id;

UPDATE memberstab m
INNER JOIN usertab u ON u.uid = m.uid
SET
  m.public_id = COALESCE(NULLIF(m.public_id, ''), NULLIF(u.public_uid, ''), UUID()),
  m.referral_slug = COALESCE(NULLIF(m.referral_slug, ''), NULLIF(u.referral_slug, ''), LOWER(LEFT(REPLACE(UUID(), '-', ''), 16)))
WHERE
  m.public_id IS NULL OR m.public_id = ''
  OR m.referral_slug IS NULL OR m.referral_slug = '';

CREATE UNIQUE INDEX uq_memberstab_public_id ON memberstab (public_id);
CREATE UNIQUE INDEX uq_memberstab_referral_slug ON memberstab (referral_slug);
