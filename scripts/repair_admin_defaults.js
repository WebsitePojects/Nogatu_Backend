const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.development') });
const mysql = require('mysql2/promise');

const DEFAULTS = {
  nogatuadmin: 'HMT*POGIgprci18',
  nogatucashier: 'joyjoy05',
  nogatubod: 'nogatualliance321654',
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [rows] = await conn.query(
    "SELECT id, username, password, CHAR_LENGTH(password) AS len FROM accesstab"
  );

  let updated = 0;
  for (const row of rows) {
    const username = String(row.username || '').trim();
    const current = String(row.password || '');
    const isTruncatedBcrypt = current.startsWith('$2') && Number(row.len) < 60;
    const fallback = DEFAULTS[username];

    if (isTruncatedBcrypt && fallback) {
      await conn.query('UPDATE accesstab SET password = ? WHERE id = ? LIMIT 1', [fallback, row.id]);
      updated++;
    }
  }

  console.log('DB:', process.env.DB_NAME);
  console.log('Admin rows checked:', rows.length);
  console.log('Truncated admin passwords repaired:', updated);

  await conn.end();
})().catch((e) => {
  console.error('REPAIR_ADMIN_ERR:', e.message);
  process.exit(1);
});
