const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function resolveEnvFile() {
  if (process.env.NODE_ENV === 'production') {
    return '.env.prod';
  }
  const candidates = ['.env.development', '.env.dev', '.env.prod'];
  for (const file of candidates) {
    if (fs.existsSync(path.join(repoRoot, file))) return file;
  }
  return '.env.dev';
}

dotenv.config({ path: path.join(repoRoot, resolveEnvFile()) });

const baseUrl = process.env.MONITOR_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;

async function fetchJson(route) {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.json().catch(() => null);
  return {
    route,
    status: response.status,
    ok: response.ok,
    body,
  };
}

async function main() {
  const [health, ready] = await Promise.all([
    fetchJson('/health'),
    fetchJson('/ready'),
  ]);

  const output = {
    checkedAt: new Date().toISOString(),
    baseUrl,
    probes: {
      health,
      ready,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (!health.ok || !ready.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Monitoring Probe] Failed:', error);
  process.exit(1);
});
