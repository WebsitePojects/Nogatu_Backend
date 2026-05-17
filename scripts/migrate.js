const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

async function main() {
  const envFile = loadBackendEnv();
  const dbConfig = getDbConfig();
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^V\d+__.+\.sql$/i.test(file))
    .sort();

  const conn = await mysql.createConnection({
    ...dbConfig,
    multipleStatements: true,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrationstab (
        version VARCHAR(32) NOT NULL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    for (const file of files) {
      const version = file.split('__')[0];
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const [rows] = await conn.query('SELECT checksum FROM schema_migrationstab WHERE version = ?', [version]);

      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${version}. Create a new corrective migration instead of editing an applied one.`);
        }
        console.log(`[migrate] skip ${file}`);
        continue;
      }

      console.log(`[migrate] apply ${file}`);
      await conn.query(sql);
      await conn.query(
        'INSERT INTO schema_migrationstab (version, filename, checksum) VALUES (?, ?, ?)',
        [version, file, checksum]
      );
    }

    console.log(`[migrate] complete using ${envFile} on ${dbConfig.database}@${dbConfig.host}`);
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error.message);
  process.exit(1);
});
