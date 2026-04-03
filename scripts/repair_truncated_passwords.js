const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.development') });
const mysql = require('mysql2/promise');

const dumpPath = path.resolve(__dirname, '../../documentations/nogatualliance_sysdb.sql');

function parseDump() {
  const content = fs.readFileSync(dumpPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const memberPasswordByUsername = new Map();
  const adminPasswordByUsername = new Map();

  for (const line of lines) {
    // memberstab row starts with: (id, uid, 'username', 'password',
    const m = line.match(/^\(\d+,\s*\d+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',/);
    if (m) {
      const username = m[1].replace(/\\'/g, "'");
      const password = m[2].replace(/\\'/g, "'");
      memberPasswordByUsername.set(username, password);
      continue;
    }

    // accesstab row starts with: (id, uid, 'username', 'password',
    const a = line.match(/^\(\d+,\s*\d+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*\d+\),?$/);
    if (a && (a[1].startsWith('nogatu') || a[1].includes('admin') || a[1].includes('cashier') || a[1].includes('bod'))) {
      const username = a[1].replace(/\\'/g, "'");
      const password = a[2].replace(/\\'/g, "'");
      adminPasswordByUsername.set(username, password);
    }
  }

  return { memberPasswordByUsername, adminPasswordByUsername };
}

async function main() {
  const { memberPasswordByUsername, adminPasswordByUsername } = parseDump();
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [truncatedMembers] = await conn.query(
    "SELECT uid, username FROM memberstab WHERE password LIKE '$2%' AND CHAR_LENGTH(password) < 60"
  );
  const [truncatedAdmins] = await conn.query(
    "SELECT id, username FROM accesstab WHERE password LIKE '$2%' AND CHAR_LENGTH(password) < 60"
  );

  let repairedMembers = 0;
  for (const row of truncatedMembers) {
    const plain = memberPasswordByUsername.get(row.username);
    if (!plain) continue;
    await conn.query('UPDATE memberstab SET password = ? WHERE uid = ? LIMIT 1', [plain, row.uid]);
    repairedMembers++;
  }

  let repairedAdmins = 0;
  for (const row of truncatedAdmins) {
    const plain = adminPasswordByUsername.get(row.username);
    if (!plain) continue;
    await conn.query('UPDATE accesstab SET password = ? WHERE id = ? LIMIT 1', [plain, row.id]);
    repairedAdmins++;
  }

  console.log('DB:', process.env.DB_NAME);
  console.log('Truncated member passwords found:', truncatedMembers.length);
  console.log('Truncated admin passwords found:', truncatedAdmins.length);
  console.log('Member passwords repaired:', repairedMembers);
  console.log('Admin passwords repaired:', repairedAdmins);

  await conn.end();
}

main().catch((err) => {
  console.error('REPAIR_ERR:', err.message);
  process.exit(1);
});
