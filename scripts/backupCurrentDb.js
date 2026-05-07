const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const mysqlFormat = require('mysql2').format;
const { loadBackendEnv, getDbConfig } = require('./env');

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

loadBackendEnv();
const db = getDbConfig();
const backupDir = path.resolve(__dirname, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const outputPath = path.join(backupDir, `${timestamp()}_pre_major_member_update.sql`);
const args = [
  `--host=${db.host}`,
  `--port=${db.port}`,
  `--user=${db.user}`,
  `--result-file=${outputPath}`,
  '--single-transaction',
  '--routines',
  '--triggers',
  db.database,
];

const env = { ...process.env, MYSQL_PWD: db.password };
const result = spawnSync('mysqldump', args, { env, stdio: 'inherit' });

if (result.error || result.status !== 0) {
  console.warn('[backup] mysqldump unavailable; using Node fallback backup.');
  fallbackBackup().catch((error) => {
    console.error('[backup] fallback failed:', error.message);
    process.exit(1);
  });
} else {
  console.log(`[backup] wrote ${outputPath}`);
}

async function fallbackBackup() {
  const conn = await mysql.createConnection(db);
  const out = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  try {
    out.write(`-- Nogatu Node fallback backup\n-- Database: ${db.database}\n-- Created: ${new Date().toISOString()}\n\n`);
    out.write('SET FOREIGN_KEY_CHECKS=0;\n\n');

    const [tables] = await conn.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
    const tableNameKey = Object.keys(tables[0] || {})[0];

    for (const tableRow of tables) {
      const table = tableRow[tableNameKey];
      const [[createRow]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
      out.write(`DROP TABLE IF EXISTS \`${table}\`;\n`);
      out.write(`${createRow['Create Table']};\n\n`);

      const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map((column) => row[column]);
        out.write(mysqlFormat(
          `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')});\n`,
          values
        ));
      }
      out.write('\n');
    }

    out.write('SET FOREIGN_KEY_CHECKS=1;\n');
  } finally {
    out.end();
    await conn.end();
  }

  await new Promise((resolve) => out.on('finish', resolve));
  console.log(`[backup] wrote ${outputPath}`);
}
