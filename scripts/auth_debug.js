const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.development') });
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [admins] = await conn.query(
    'SELECT username, password, CHAR_LENGTH(password) AS len FROM accesstab ORDER BY id'
  );
  const [members] = await conn.query(
    "SELECT username, password, CHAR_LENGTH(password) AS len FROM memberstab WHERE username IN ('00001','00002','00003','Themaker','Ann050890')"
  );

  console.log('DB:', process.env.DB_NAME);
  console.log('Admins:', admins.map((r) => ({
    username: r.username,
    len: r.len,
    prefix: String(r.password || '').slice(0, 6),
  })));
  console.log('Members sample:', members.map((r) => ({
    username: r.username,
    len: r.len,
    prefix: String(r.password || '').slice(0, 6),
  })));

  await conn.end();
})().catch((e) => {
  console.error('AUTH_DEBUG_ERR:', e.message);
  process.exit(1);
});
