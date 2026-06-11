-- V026: Widen processid columns to VARCHAR(64) and repurchasetab.code to VARCHAR(30)
--
-- Root cause: createProcessKey() returns a 64-char SHA-256 hex string.
-- Production tables inherited VARCHAR(12) from the PHP system.
-- repurchasetab.code also needs widening for voucher reference codes.

ALTER TABLE payouthistorytab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE codehistorytab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE codestab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE h5historytab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE repurchasetab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL,
  MODIFY COLUMN code VARCHAR(30) DEFAULT NULL;

ALTER TABLE upgradetab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE globalbonus_poolstab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE globalbonus_membertab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;

ALTER TABLE globalbonus_override_tab
  MODIFY COLUMN processid VARCHAR(64) DEFAULT NULL;
