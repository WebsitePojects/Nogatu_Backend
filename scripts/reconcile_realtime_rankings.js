const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  const value = index >= 0 ? Number(argv[index + 1]) : 200;
  return Math.max(1, Math.min(1000, value || 200));
}

function assertProductionTarget(envFile, config) {
  if (process.env.NODE_ENV !== 'production') return;
  if (!String(envFile).endsWith('.env.prod') || config.database !== 'nogatualliance_sysdb') {
    throw new Error(`Refusing production reconciliation for ${config.database} using ${envFile}`);
  }
}

async function main() {
  const envFile = loadBackendEnv();
  const config = getDbConfig();
  assertProductionTarget(envFile, config);
  const limit = parseLimit(process.argv.slice(2));
  console.log(`[ranking:reconcile] env=${envFile} db=${config.database}@${config.host}`);
  const conn = await mysql.createConnection(config);
  try {
    const [aggregateDrift] = await conn.query(
      `SELECT p.member_uid,
              p.remaining_points AS aggregate_remaining,
              COALESCE(r.remaining_rankable_points,0) AS snapshot_remaining,
              ABS(p.remaining_points - COALESCE(r.remaining_rankable_points,0)) AS difference
         FROM member_rank_pointstab p
         LEFT JOIN rankingstab r ON r.uid = p.member_uid
        HAVING difference > 0.5
        ORDER BY difference DESC
        LIMIT ?`,
      [limit]
    );
    const [stuckProcesses] = await conn.query(
      `SELECT repurchase_id, source_member_uid, started_at
         FROM ranking_event_processstab
        WHERE status = 'processing' AND started_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 2 MINUTE)
        ORDER BY started_at ASC LIMIT ?`,
      [limit]
    );
    const [pendingOutbox] = await conn.query(
      `SELECT id, repurchase_id, status, attempts, available_at, last_error
         FROM ranking_realtime_outboxtab
        WHERE status <> 'published' AND created_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 2 MINUTE)
        ORDER BY id ASC LIMIT ?`,
      [limit]
    );
    const report = {
      aggregateDriftCount: aggregateDrift.length,
      stuckProcessCount: stuckProcesses.length,
      pendingOutboxCount: pendingOutbox.length,
      aggregateDrift,
      stuckProcesses,
      pendingOutbox,
    };
    console.log(JSON.stringify(report, null, 2));
    if (aggregateDrift.length || stuckProcesses.length || pendingOutbox.length) process.exitCode = 2;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[ranking:reconcile] failed:', error.message);
    process.exit(1);
  });
}

module.exports = { parseLimit, assertProductionTarget };
