/**
 * One-time migration: hash all plaintext passwords in memberstab and accesstab.
 *
 * Safe to run multiple times — already-hashed passwords (starting with $2) are skipped.
 * Run BEFORE deploying to production so that all accounts are bcrypt-protected,
 * not just those who have logged in since the bcrypt rollout.
 *
 * Usage:
 *   node scripts/hash-existing-passwords.js
 *   NODE_ENV=production node scripts/hash-existing-passwords.js
 *
 * Estimated time: ~2 seconds per 100 accounts (bcrypt rounds=12 is intentionally slow).
 */
const path = require('path');

function resolveEnvFile() {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return '.env.prod';
  if (env === 'staging') return '.env.staging';
  const fs = require('fs');
  for (const f of ['.env.development', '.env.dev']) {
    if (fs.existsSync(path.resolve(__dirname, '..', f))) return f;
  }
  return '.env.dev';
}
require('dotenv').config({ path: path.resolve(__dirname, '..', resolveEnvFile()) });

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;
const BATCH_SIZE = 50;

async function hashBatch(conn, table, idCol, rows, dryRun) {
  let hashed = 0;
  let skipped = 0;
  for (const row of rows) {
    const pw = String(row.password || '');
    if (pw.startsWith('$2') && pw.length >= 60) {
      skipped++;
      continue;
    }
    if (!pw) {
      console.warn(`  [SKIP] ${table} ${idCol}=${row[idCol]} — empty password, leaving as-is`);
      skipped++;
      continue;
    }
    if (!dryRun) {
      const newHash = await bcrypt.hash(pw, SALT_ROUNDS);
      await conn.query(`UPDATE ${table} SET password = ? WHERE ${idCol} = ? LIMIT 1`, [newHash, row[idCol]]);
    }
    hashed++;
  }
  return { hashed, skipped };
}

async function processTable(conn, table, idCol, dryRun) {
  const [allRows] = await conn.query(`SELECT ${idCol}, password FROM ${table}`);
  const plaintext = allRows.filter(r => {
    const pw = String(r.password || '');
    return !(pw.startsWith('$2') && pw.length >= 60);
  });

  if (plaintext.length === 0) {
    console.log(`[${table}] All ${allRows.length} passwords already hashed. Nothing to do.`);
    return { total: allRows.length, hashed: 0, skipped: allRows.length };
  }

  console.log(`[${table}] ${plaintext.length} plaintext / ${allRows.length - plaintext.length} already hashed.`);
  if (dryRun) {
    console.log(`[${table}] DRY RUN — would hash ${plaintext.length} passwords.`);
    return { total: allRows.length, hashed: plaintext.length, skipped: allRows.length - plaintext.length };
  }

  let totalHashed = 0;
  let totalSkipped = 0;
  for (let i = 0; i < plaintext.length; i += BATCH_SIZE) {
    const batch = plaintext.slice(i, i + BATCH_SIZE);
    const { hashed, skipped } = await hashBatch(conn, table, idCol, batch, dryRun);
    totalHashed += hashed;
    totalSkipped += skipped;
    const pct = Math.round(((i + batch.length) / plaintext.length) * 100);
    process.stdout.write(`\r[${table}] Progress: ${i + batch.length}/${plaintext.length} (${pct}%)`);
  }
  process.stdout.write('\n');
  return { total: allRows.length, hashed: totalHashed, skipped: totalSkipped };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN mode — no changes will be written.\n');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log(`Connected to: ${process.env.DB_NAME} @ ${process.env.DB_HOST}\n`);

  try {
    const memberResult = await processTable(conn, 'memberstab', 'uid', dryRun);
    const adminResult = await processTable(conn, 'accesstab', 'id', dryRun);

    console.log('\n--- Summary ---');
    console.log(`memberstab: ${memberResult.hashed} hashed, ${memberResult.skipped} already-hashed/skipped`);
    console.log(`accesstab:  ${adminResult.hashed} hashed, ${adminResult.skipped} already-hashed/skipped`);
    if (!dryRun) {
      console.log('\nAll plaintext passwords have been migrated to bcrypt.');
    }
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
