const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig, assertNotProductionDatabase } = require('./env');

function parseArgs(argv) {
  const args = { yes: false, dump: '', confirmDbName: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--yes') {
      args.yes = true;
    } else if (token === '--dump') {
      args.dump = argv[index + 1] || '';
      index += 1;
    } else if (token === '--confirm-db-name') {
      args.confirmDbName = argv[index + 1] || '';
      index += 1;
    }
  }
  return args;
}

function runStep(label, command, args, options = {}) {
  console.log(`[replace-db] ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function fallbackImport({ dbConfig, dumpPath }) {
  const admin = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true,
  });

  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbConfig.database}\``);
    await admin.query(`CREATE DATABASE \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.end();
  }

  const conn = await mysql.createConnection({ ...dbConfig, multipleStatements: true });
  try {
    const sql = fs.readFileSync(dumpPath, 'utf8')
      .replace(/^CREATE DATABASE .*?;\s*/gim, '')
      .replace(/^USE .*?;\s*/gim, '');

    let statement = '';
    const lines = sql.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
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
}

async function importDump({ dbConfig, dumpPath }) {
  const env = { ...process.env, MYSQL_PWD: dbConfig.password };
  const createArgs = [
    `--host=${dbConfig.host}`,
    `--port=${dbConfig.port}`,
    `--user=${dbConfig.user}`,
    '-e',
    `DROP DATABASE IF EXISTS \`${dbConfig.database}\`; CREATE DATABASE \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  ];

  const createResult = spawnSync('mysql', createArgs, { env, stdio: 'inherit' });
  if (createResult.error || createResult.status !== 0) {
    console.warn('[replace-db] mysql CLI recreate failed; using Node fallback import.');
    await fallbackImport({ dbConfig, dumpPath });
    return;
  }

  const importArgs = [
    `--host=${dbConfig.host}`,
    `--port=${dbConfig.port}`,
    `--user=${dbConfig.user}`,
    dbConfig.database,
  ];

  const sqlBuffer = fs.readFileSync(dumpPath);
  const importResult = spawnSync('mysql', importArgs, {
    env,
    input: sqlBuffer,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (importResult.error || importResult.status !== 0) {
    console.warn('[replace-db] mysql CLI import failed; using Node fallback import.');
    await fallbackImport({ dbConfig, dumpPath });
    return;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dump) {
    throw new Error(
      'Usage: node scripts/replaceDbFromDump.js --dump /absolute/path/to/latest.sql --yes --confirm-db-name <database>'
    );
  }
  if (!args.yes) {
    throw new Error('Refusing destructive DB replace without --yes');
  }

  const envFile = loadBackendEnv();
  const dbConfig = getDbConfig();

  // Block destructive operation on production/remote databases before doing anything else.
  assertNotProductionDatabase(dbConfig, 'replace-db');

  // Require the caller to re-type the database name to prevent fat-finger mistakes.
  if (!args.confirmDbName) {
    console.error('\n[replace-db] REFUSED — --confirm-db-name is required.');
    console.error(`[replace-db] This will DROP DATABASE \`${dbConfig.database}\` and recreate it from the dump.`);
    console.error(`[replace-db] Pass --confirm-db-name ${dbConfig.database} to confirm.\n`);
    process.exit(2);
  }
  if (args.confirmDbName !== dbConfig.database) {
    console.error(`\n[replace-db] REFUSED — name mismatch.`);
    console.error(`  Configured DB : ${dbConfig.database}`);
    console.error(`  You confirmed : ${args.confirmDbName}`);
    console.error('[replace-db] These must match exactly.\n');
    process.exit(2);
  }

  const dumpPath = path.resolve(args.dump);

  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump file not found: ${dumpPath}`);
  }

  console.log(`[replace-db] using ${envFile} on ${dbConfig.database}@${dbConfig.host}:${dbConfig.port}`);
  console.log(`[replace-db] dump: ${dumpPath}`);

  runStep('backup current database', process.execPath, [path.resolve(__dirname, 'backupCurrentDb.js')], {
    env: process.env,
  });

  console.log('[replace-db] replace database from dump');
  await importDump({ dbConfig, dumpPath });

  runStep('apply backend migrations', process.execPath, [path.resolve(__dirname, 'migrate.js')], {
    env: process.env,
  });

  runStep('run schema smoke verification', process.execPath, [path.resolve(__dirname, 'smoke.js')], {
    env: process.env,
  });

  console.log('[replace-db] complete');
}

main().catch((error) => {
  console.error('[replace-db] failed:', error.message);
  process.exit(1);
});
