const fs = require('fs');
const path = require('path');

const LOCALHOST_ALIASES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PROD_OVERRIDE_VAR = 'ALLOW_DESTRUCTIVE_DB_OPS';
const PROD_OVERRIDE_VALUE = 'I_UNDERSTAND_THIS_DESTROYS_LIVE_DATA';

function loadBackendEnv() {
  const envFile = process.env.NODE_ENV === 'production'
    ? '.env.prod'
    : (fs.existsSync(path.resolve(__dirname, '..', '.env.development')) ? '.env.development' : '.env.dev');

  const envPath = path.resolve(__dirname, '..', envFile);
  // Fail LOUD if the selected env file is missing. Without this, a script run with
  // NODE_ENV=production on a host that has no .env.prod (e.g. GREEN/staging) loads NOTHING,
  // and getDbConfig() then falls back to defaults that point at the PROD database — the
  // "looks like prod but is the unconfigured fallback" trap. Refusing beats guessing.
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `[env] ${envFile} not found (NODE_ENV=${process.env.NODE_ENV || 'unset'}). Refusing to run ` +
      `with an unconfigured environment — this is the trap that would silently target the prod DB. ` +
      `Use the right NODE_ENV for this host (green: NO NODE_ENV -> .env.dev; blue: NODE_ENV=production -> .env.prod).`
    );
  }
  require('dotenv').config({ path: envPath });
  return envFile;
}

function getDbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    // NO prod-name default: an unset DB_NAME must fail to connect, never silently resolve to
    // the live production database. loadBackendEnv() above already refuses a missing env file.
    database: process.env.DB_NAME,
  };
}

/**
 * Hard guard against running destructive DB operations on production.
 *
 * Refuses and exits if any of these are true:
 *   - NODE_ENV is "production"
 *   - DB_HOST resolves to a non-localhost address (remote server)
 *
 * The only escape hatch is setting:
 *   ALLOW_DESTRUCTIVE_DB_OPS=I_UNDERSTAND_THIS_DESTROYS_LIVE_DATA
 *
 * That variable must be present in the environment, not in any .env file,
 * to ensure it is a deliberate, per-invocation decision.
 *
 * @param {object} dbConfig - result of getDbConfig()
 * @param {string} scriptName - human-readable name for the error message
 */
function assertNotProductionDatabase(dbConfig, scriptName) {
  const override = String(process.env[PROD_OVERRIDE_VAR] || '').trim();
  if (override === PROD_OVERRIDE_VALUE) {
    console.warn(`\n[${scriptName}] WARNING: production guard bypassed via ${PROD_OVERRIDE_VAR}.`);
    console.warn(`[${scriptName}] Targeting database: ${dbConfig.database} @ ${dbConfig.host}\n`);
    return;
  }

  const reasons = [];

  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    reasons.push(`NODE_ENV is "production"`);
  }

  const host = String(dbConfig.host || '').trim().toLowerCase();
  if (host && !LOCALHOST_ALIASES.has(host)) {
    reasons.push(`DB_HOST "${dbConfig.host}" is not localhost — this looks like a remote/production server`);
  }

  if (reasons.length === 0) return;

  console.error(`\n[${scriptName}] REFUSED — destructive DB operation blocked for safety.`);
  console.error(`[${scriptName}] Reason(s):`);
  for (const r of reasons) console.error(`  • ${r}`);
  console.error(`\n[${scriptName}] This script can drop or overwrite the entire "${dbConfig.database}" database.`);
  console.error(`[${scriptName}] If you are certain this is safe, set this environment variable BEFORE running:`);
  console.error(`\n  ${PROD_OVERRIDE_VAR}="${PROD_OVERRIDE_VALUE}"\n`);
  process.exit(2);
}

module.exports = { loadBackendEnv, getDbConfig, assertNotProductionDatabase };
