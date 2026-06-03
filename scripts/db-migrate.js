const fs = require('fs');
const path = require('path');

function resolveEnvFile() {
  if (process.env.NODE_ENV === 'production') {
    return '.env.prod';
  }

  const candidates = ['.env.development', '.env.dev'];
  for (const file of candidates) {
    if (fs.existsSync(path.resolve(__dirname, '..', file))) {
      return file;
    }
  }

  return '.env.dev';
}

const envFile = resolveEnvFile();
require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });

const { pool } = require('../config/database');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (char === '-' && next === '-' && /[\s]/.test(sql[index + 2] || ' ')) {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
    }

    if (char === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (char === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (char === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      current += char;
      continue;
    }

    if (char === ';' && !inSingle && !inDouble && !inBacktick) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements;
}

function isIgnorableSchemaError(error) {
  return [
    'ER_DUP_KEYNAME',
    'ER_DUP_FIELDNAME',
    'ER_TABLE_EXISTS_ERROR',
    'ER_DUP_ENTRY',
  ].includes(error.code);
}

async function backfillBinaryTreeClosure(connection) {
  console.log('[db:migrate] Backfilling binary_tree_closuretab from usertab');

  const [rows] = await connection.query('SELECT uid, refid, position FROM usertab ORDER BY uid');
  const childrenByParent = new Map();
  const uids = [];

  for (const row of rows) {
    const uid = Number(row.uid);
    if (!Number.isFinite(uid) || uid <= 0) continue;

    uids.push(uid);

    const parentUid = Number(row.refid || 0);
    if (!childrenByParent.has(parentUid)) {
      childrenByParent.set(parentUid, []);
    }
    childrenByParent.get(parentUid).push({
      uid,
      position: Number(row.position || 0),
    });
  }

  const batchSize = 500;
  let buffer = [];
  let totalRows = 0;

  async function flushBuffer() {
    if (buffer.length === 0) return;

    await connection.query(
      `INSERT INTO binary_tree_closuretab
         (ancestor_uid, descendant_uid, depth, path_side, path_text)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         depth = VALUES(depth),
         path_side = VALUES(path_side),
         path_text = VALUES(path_text)`,
      [buffer]
    );

    totalRows += buffer.length;
    buffer = [];
  }

  for (const ancestorUid of uids) {
    const stack = [{
      descendantUid: ancestorUid,
      depth: 0,
      pathSide: 'SELF',
      pathText: String(ancestorUid),
    }];

    while (stack.length > 0) {
      const current = stack.pop();

      buffer.push([
        ancestorUid,
        current.descendantUid,
        current.depth,
        current.pathSide,
        current.pathText,
      ]);

      if (buffer.length >= batchSize) {
        await flushBuffer();
      }

      const children = childrenByParent.get(current.descendantUid) || [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        stack.push({
          descendantUid: child.uid,
          depth: current.depth + 1,
          pathSide: `${current.pathSide}${child.position === 1 ? 'L' : 'R'}`,
          pathText: `${current.pathText}>${child.uid}`,
        });
      }
    }
  }

  await flushBuffer();
  console.log(`[db:migrate] Backfilled ${totalRows} closure rows`);
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version VARCHAR(255) NOT NULL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function main() {
  await ensureMigrationsTable();

  const [appliedRows] = await pool.query(`SELECT version FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(appliedRows.map((row) => String(row.version)));

  const files = (await fs.promises.readdir(MIGRATIONS_DIR))
    .filter((file) => /^V\d+__.*\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right));

  const connection = await pool.getConnection();

  try {
    for (const fileName of files) {
      const version = fileName.split('__')[0];
      if (applied.has(version)) {
        console.log(`[db:migrate] Skipping ${fileName} (already applied)`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, fileName);
      const sql = await fs.promises.readFile(filePath, 'utf8');
      const statements = splitSqlStatements(sql);

      console.log(`[db:migrate] Applying ${fileName}`);
      if (version === 'V008') {
        await backfillBinaryTreeClosure(connection);
      } else {
        for (const statement of statements) {
          try {
            await connection.query(statement);
          } catch (error) {
            if (isIgnorableSchemaError(error)) {
              console.log(`[db:migrate] Ignored schema conflict in ${fileName}: ${error.code}`);
              continue;
            }

            error.message = `${fileName}: ${error.message}`;
            throw error;
          }
        }
      }

      await connection.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, filename)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE filename = VALUES(filename), applied_at = CURRENT_TIMESTAMP`,
        [version, fileName]
      );

      console.log(`[db:migrate] Applied ${fileName}`);
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[db:migrate] Failed:', error.message);
  process.exit(1);
});