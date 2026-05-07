const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

loadBackendEnv();
const db = getDbConfig();
const dumpPath = path.resolve(__dirname, '..', '..', 'reference_system', 'nogatualliance_sysdb.sql');

if (!fs.existsSync(dumpPath)) {
  console.error(`[import] reference dump not found: ${dumpPath}`);
  process.exit(1);
}

const createArgs = [
  `--host=${db.host}`,
  `--port=${db.port}`,
  `--user=${db.user}`,
  '-e',
  `CREATE DATABASE IF NOT EXISTS \`${db.database}\`;`,
];

const env = { ...process.env, MYSQL_PWD: db.password };
let result = spawnSync('mysql', createArgs, { env, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.warn('[import] mysql CLI unavailable; using Node fallback import.');
  fallbackImport().catch((error) => {
    console.error('[import] fallback failed:', error.message);
    process.exit(1);
  });
  return;
}

const importArgs = [
  `--host=${db.host}`,
  `--port=${db.port}`,
  `--user=${db.user}`,
  db.database,
];

const sql = fs.readFileSync(dumpPath);
result = spawnSync('mysql', importArgs, { env, input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error || result.status !== 0) {
  console.warn('[import] mysql CLI import failed; using Node fallback import.');
  fallbackImport().catch((error) => {
    console.error('[import] fallback failed:', error.message);
    process.exit(1);
  });
} else {
  console.log(`[import] imported ${dumpPath} into ${db.database}`);
}

async function fallbackImport() {
  const admin = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    multipleStatements: true,
  });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${db.database}\``);
  } finally {
    await admin.end();
  }

  const conn = await mysql.createConnection({ ...db, multipleStatements: true });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    const [existingTables] = await conn.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
    const tableNameKey = Object.keys(existingTables[0] || {})[0];
    for (const row of existingTables) {
      await conn.query(`DROP TABLE IF EXISTS \`${row[tableNameKey]}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS=1');

    const sql = fs.readFileSync(dumpPath, 'utf8')
      .replace(/^CREATE DATABASE .*?;\s*/gim, '')
      .replace(/^USE .*?;\s*/gim, '');
    let statement = '';
    const lines = sql.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*') || trimmed.startsWith('LOCK TABLES') || trimmed.startsWith('UNLOCK TABLES')) {
        continue;
      }
      statement += `${line}\n`;
      if (trimmed.endsWith(';')) {
        const current = statement.trim();
        statement = '';
        if (current) {
          await conn.query(current);
        }
      }
    }
    if (statement.trim()) {
      await conn.query(statement);
    }
  } finally {
    await conn.end();
  }

  console.log(`[import] imported ${dumpPath} into ${db.database}`);
}
