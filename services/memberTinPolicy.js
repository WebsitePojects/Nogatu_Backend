const { pool } = require('../config/database');

let memberTinColumnsReady = false;
let memberHasTinNoColumn = false;

async function ensureMemberTinColumns(conn = pool) {
  if (memberTinColumnsReady) return;

  const [tinNoColumns] = await conn.query(
    `SELECT 1 AS ok
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'memberstab'
        AND column_name = 'tinno'
      LIMIT 1`
  );

  memberHasTinNoColumn = tinNoColumns.length > 0;
  memberTinColumnsReady = true;
}

async function getResolvedMemberTin(uid, conn = pool) {
  await ensureMemberTinColumns(conn);

  const tinSelect = memberHasTinNoColumn
    ? 'COALESCE(NULLIF(TRIM(tin), \'\'), NULLIF(TRIM(tinno), \'\')) AS resolvedTin'
    : 'NULLIF(TRIM(tin), \'\') AS resolvedTin';

  const [rows] = await conn.query(
    `SELECT ${tinSelect}
       FROM memberstab
      WHERE uid = ?
      LIMIT 1`,
    [uid]
  );

  return rows[0]?.resolvedTin || null;
}

async function assertTinPresentForEncashment(uid, conn = pool) {
  const resolvedTin = await getResolvedMemberTin(uid, conn);
  if (resolvedTin) {
    return resolvedTin;
  }

  const error = new Error('TIN is required before encashment. Please complete your account profile first.');
  error.code = 'TIN_REQUIRED_FOR_ENCASHMENT';
  error.statusCode = 422;
  throw error;
}

module.exports = {
  ensureMemberTinColumns,
  getResolvedMemberTin,
  assertTinPresentForEncashment,
};
