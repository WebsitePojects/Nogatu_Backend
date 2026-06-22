const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const loadedEnvFile = loadBackendEnv();
const loadedDbConfig = getDbConfig();
const { createProcessKey } = require('../utils/security');
const {
  acquireRankingLock,
  releaseRankingLock,
  processRepurchaseRankingEvent,
} = require('../services/rankingEventProcessor');
const { flushRankingOutboxForRepurchase } = require('../services/rankingRealtime');

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? Number(argv[index + 1]) : null;
}

function assertProductionTarget(envFile, config) {
  if (process.env.NODE_ENV !== 'production') return;
  if (!String(envFile).endsWith('.env.prod') || config.database !== 'nogatualliance_sysdb') {
    throw new Error(`Refusing production replay for ${config.database} using ${envFile}`);
  }
}

async function markBaseline(conn, throughId) {
  const [rows] = await conn.query(
    `SELECT id, uid, COALESCE(incentivepoints1,0) AS points
       FROM repurchasetab
      WHERE id <= ? AND COALESCE(incentivepoints1,0) > 0
      ORDER BY id ASC`,
    [throughId]
  );
  for (const row of rows) {
    await conn.query(
      `INSERT IGNORE INTO ranking_event_processstab
         (repurchase_id, source_member_uid, points, process_key, status,
          affected_member_count, completed_at)
       VALUES (?, ?, ?, ?, 'completed', 0, CURRENT_TIMESTAMP(6))`,
      [row.id, row.uid, row.points, createProcessKey(['ranking-baseline', row.id])]
    );
  }
  return rows.length;
}

async function replayOne(conn, row) {
  let lockHeld = false;
  try {
    await acquireRankingLock(conn, 30);
    lockHeld = true;
    await conn.beginTransaction();
    const result = await processRepurchaseRankingEvent(conn, {
      repurchaseId: row.id,
      sourceMemberUid: row.uid,
      points: row.points,
      maintenanceBucket: row.maintenance_bucket,
      transactionType: row.transtype,
    });
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    if (lockHeld) await releaseRankingLock(conn);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const envFile = loadedEnvFile;
  const config = loadedDbConfig;
  assertProductionTarget(envFile, config);
  console.log(`[ranking:replay] env=${envFile} db=${config.database}@${config.host}`);
  const conn = await mysql.createConnection(config);
  try {
    const [[highWater]] = await conn.query('SELECT COALESCE(MAX(id),0) AS id FROM repurchasetab');
    if (argv.includes('--print-high-water')) {
      console.log(Number(highWater.id));
      return;
    }
    const baselineThrough = valueAfter(argv, '--mark-baseline-through');
    if (baselineThrough > 0) {
      const count = await markBaseline(conn, baselineThrough);
      console.log(`[ranking:replay] baseline marked through ${baselineThrough}; eligible rows=${count}`);
      return;
    }
    const fromId = valueAfter(argv, '--from-id');
    const toId = valueAfter(argv, '--to-id') || Number(highWater.id);
    if (!Number.isInteger(fromId) || fromId <= 0) {
      throw new Error('--from-id must be a positive integer');
    }
    const [rows] = await conn.query(
      `SELECT id, uid, COALESCE(incentivepoints1,0) AS points, maintenance_bucket, transtype
         FROM repurchasetab
        WHERE id BETWEEN ? AND ? AND COALESCE(incentivepoints1,0) > 0
        ORDER BY id ASC`,
      [fromId, toId]
    );
    for (const row of rows) {
      const result = await replayOne(conn, row);
      if (!result.alreadyProcessed) await flushRankingOutboxForRepurchase(row.id);
      console.log(`[ranking:replay] repurchase=${row.id} affected=${result.affectedMemberUids.length}`);
    }
    console.log(`[ranking:replay] complete rows=${rows.length} range=${fromId}-${toId}`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[ranking:replay] failed:', error.message);
    process.exit(1);
  });
}

module.exports = { valueAfter, assertProductionTarget, markBaseline, replayOne };
