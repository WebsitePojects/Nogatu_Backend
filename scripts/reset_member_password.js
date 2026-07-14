/**
 * Admin utility — reset a member's LOGIN password to a default by username.
 *
 * A password reset only rewrites memberstab.password. It NEVER touches the
 * wallet, income, or any money column — resetting a password is free.
 *
 * Safety design (this writes to the LIVE members table):
 *  - Prints `env=… DB=user@host/name` as line 1 so the operator can abort.
 *  - DRY-RUN by default. Nothing is written unless you pass --commit.
 *  - Matches a username case-insensitively and tolerant of trailing spaces,
 *    but if the lookup returns MORE THAN ONE row it REFUSES to write that
 *    name (you resolve the ambiguity by hand) — never guesses which to reset.
 *  - Updates strictly by uid (LIMIT 1) and records an audit_logtab row.
 *
 * Usage (BLUE / production — where the live members are):
 *   cd /var/www/nogatu
 *   NODE_ENV=production node scripts/reset_member_password.js --username Floramie048            # dry-run preview
 *   NODE_ENV=production node scripts/reset_member_password.js --username Floramie048 --commit   # actually reset
 *   NODE_ENV=production node scripts/reset_member_password.js --username Floramie048 --username Richdad88 --commit
 *
 * Options:
 *   --username <name>   member username (repeatable). Positional args also work.
 *   --password <pw>     password to set (default: 123456)
 *   --commit            perform the write (omit for a dry run)
 */
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const SALT_ROUNDS = 12;
const DEFAULT_PASSWORD = '123456';

function parseArgs(argv) {
  const usernames = [];
  let password = DEFAULT_PASSWORD;
  let commit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username' || arg === '-u') {
      const next = argv[i + 1];
      if (next) { usernames.push(next); i += 1; }
    } else if (arg === '--password' || arg === '-p') {
      const next = argv[i + 1];
      if (next) { password = next; i += 1; }
    } else if (arg === '--commit') {
      commit = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (!arg.startsWith('-')) {
      usernames.push(arg);
    }
  }
  return { usernames, password, commit };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: NODE_ENV=production node scripts/reset_member_password.js --username <name> [--username <name2>] [--password 123456] [--commit]');
    return;
  }

  const envFile = loadBackendEnv();
  const dbConfig = getDbConfig();
  console.log(`env=${process.env.NODE_ENV || 'unset'} (${envFile}) DB=${dbConfig.user}@${dbConfig.host}/${dbConfig.database}`);

  if (opts.usernames.length === 0) {
    console.error('No usernames given. Pass --username <name> (repeatable).');
    process.exitCode = 1;
    return;
  }
  if (!opts.password) {
    console.error('Empty password not allowed.');
    process.exitCode = 1;
    return;
  }

  console.log(`mode=${opts.commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}  password="${opts.password}"  accounts=${opts.usernames.length}`);
  console.log('-------------------------------------------------------------');

  const conn = await mysql.createConnection(dbConfig);
  let hash = null;
  let updated = 0;
  let skipped = 0;
  try {
    hash = await bcrypt.hash(opts.password, SALT_ROUNDS);

    for (const rawName of opts.usernames) {
      const name = String(rawName).trim();
      // MySQL's PADSPACE collation makes `= ?` tolerant of trailing spaces and
      // (CI collation) case; the explicit TRIM(username) = ? is a belt-and-braces
      // catch for stored values whose spaces are interior/odd.
      const [rows] = await conn.query(
        `SELECT uid, username, CHAR_LENGTH(username) AS ulen
         FROM memberstab
         WHERE username = ? OR TRIM(username) = ?`,
        [name, name]
      );

      if (rows.length === 0) {
        console.log(`SKIP  "${name}" — NOT FOUND`);
        skipped += 1;
        continue;
      }
      if (rows.length > 1) {
        console.log(`SKIP  "${name}" — AMBIGUOUS, ${rows.length} rows match (resolve by hand):`);
        rows.forEach((r) => console.log(`        uid=${r.uid} username="${r.username}" (len ${r.ulen})`));
        skipped += 1;
        continue;
      }

      const row = rows[0];
      const spaceNote = row.ulen !== name.length ? `  [stored has padding: len ${row.ulen}]` : '';
      if (!opts.commit) {
        console.log(`WOULD RESET  uid=${row.uid} username="${row.username}"${spaceNote}`);
        continue;
      }

      const [res] = await conn.query(
        'UPDATE memberstab SET password = ? WHERE uid = ? LIMIT 1',
        [hash, row.uid]
      );
      if (res.affectedRows === 1) {
        updated += 1;
        console.log(`RESET  uid=${row.uid} username="${row.username}"${spaceNote} — OK`);
        try {
          await conn.query(
            `INSERT INTO audit_logtab
             (actor_uid, actor_role, action, target_uid, target_table, target_id,
              before_state, after_state, ip_address, user_agent, request_id)
             VALUES (NULL, 'system', 'auth.password_reset.admin_script', ?, 'memberstab', ?, NULL, ?, NULL, 'reset_member_password.js', ?)`,
            [row.uid, String(row.uid), JSON.stringify({ username: row.username, resetToDefault: true }), `pwreset-${row.uid}-${Date.now()}`]
          );
        } catch (auditErr) {
          if (auditErr.code !== 'ER_NO_SUCH_TABLE') {
            console.warn(`       (audit log failed: ${auditErr.message})`);
          }
        }
      } else {
        console.log(`WARN   uid=${row.uid} username="${row.username}" — no row updated`);
        skipped += 1;
      }
    }
  } finally {
    await conn.end();
  }

  console.log('-------------------------------------------------------------');
  if (opts.commit) {
    console.log(`Done. reset=${updated}  skipped=${skipped}`);
  } else {
    console.log(`Dry run complete. Re-run with --commit to apply. (${opts.usernames.length} account(s) previewed)`);
  }
}

main().catch((err) => {
  console.error('[reset_member_password] FATAL:', err.message);
  process.exitCode = 1;
});
