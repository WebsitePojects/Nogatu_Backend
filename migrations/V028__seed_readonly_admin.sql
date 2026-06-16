-- V028: Seed the read-only admin account (role-gated GET-only access).
--
-- This account exists in local dumps but was never seeded by a migration, so
-- production (provisioned via db:migrate) is missing it and the login 401s.
-- Idempotent: inserts only when username 'nogaturead' is absent, and picks the
-- next free id so it never collides with an existing accesstab primary key.
--
-- Password (bcrypt, cost 12): NAWI@readonly01
-- role='readonly' triggers readonlyGuard (blocks all non-GET); rights=1 lets it
-- pass the admin role gates for read access.

INSERT INTO accesstab (id, uid, username, password, name, rights, role)
SELECT t.nid, t.nid, 'nogaturead',
       '$2a$12$fCdIJ7580Pnpd/o/tIRKWeeLZUHxB/W0rtEP9C6LcFkvAzKIzuu8u',
       'Read Only Admin', 1, 'readonly'
FROM (SELECT COALESCE(MAX(id), 0) + 1 AS nid FROM accesstab) t
WHERE NOT EXISTS (SELECT 1 FROM accesstab WHERE username = 'nogaturead');
