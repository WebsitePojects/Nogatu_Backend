#!/usr/bin/env node
/**
 * Offline reconstruction of a member's full pairing (SMB) event trace.
 *
 * Run AFTER scripts/rebuild_binary_closure.js (the trace reads the closure to
 * resolve each event's leg relative to the owner — a starved closure starves
 * the trace).
 *
 * syncPairingLedger() backfills a binary_point_event per eligible descendant,
 * matches left vs right chronologically into pairing_ledgerstab, and writes the
 * forward income_eventstab 'pairing_bonus' rows used by the transaction trace.
 * For a big leader this touches ~1,300+ sources and is too slow to run on a
 * page view — so we run it here, once, offline.
 *
 * Then it reconciles the reconstructed traceable income against the
 * AUTHORITATIVE lifetime SMB (payouttotaltab.ttlincome2). It NEVER writes to
 * ttlincome2 / payouthistorytab — money is read-only here; this only rebuilds
 * the display/trace ledger.
 *
 *   node scripts/rebuild_pairing_trace.js [uid]        # default uid = 6122895 (Elmer)
 */

const { loadBackendEnv, getDbConfig } = require('./env');

// MUST load env BEFORE requiring config/database (it builds the pool at
// require-time from process.env). See CLAUDE.md "VPS Command Discipline".
const envFile = loadBackendEnv();
const dbConfig = getDbConfig();
console.log(
  `[rebuild_pairing_trace] env=${envFile} DB=${dbConfig.user}@${dbConfig.host}/${dbConfig.database}`
);

const { pool } = require('../config/database');
const { syncPairingLedger } = require('../services/income/pairingTracker');

async function main() {
  const uid = Number(process.argv[2] || 6122895);

  const [[u]] = await pool.query(
    `SELECT u.uid, m.username, u.currentaccttype
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = ? LIMIT 1`,
    [uid]
  );
  if (!u) {
    console.error(`[error] uid ${uid} not found in usertab`);
    process.exit(1);
  }
  console.log(`[trace] owner uid=${u.uid} username=${u.username} accttype=${u.currentaccttype}`);

  const t0 = Date.now();
  const result = await syncPairingLedger(uid, u.currentaccttype);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const s = result.summary || {};
  console.log(`[trace] done in ${secs}s`);
  console.log(`[trace] source backfill: inserted=${result.sourceBackfill.inserted} skipped=${result.sourceBackfill.skipped}`);
  console.log(`[trace] ledger rows=${result.rows.length}`);
  console.log(`[trace] matched points=${s.totalPairPoints} matchedPV=${s.totalPairPoints ? (s.totalPairPoints / 250).toFixed(2) : 0}`);
  console.log(`[trace] traceable credited income=${s.totalCreditedIncome}`);

  // Reconcile against the authoritative lifetime SMB. Report the gap; do NOT
  // touch it. A remaining gap means more eligible source events still need to
  // reconstruct (or genuinely-legacy aggregate with no per-event records).
  const [[pt]] = await pool.query(
    'SELECT ROUND(ttlincome2) AS smb FROM payouttotaltab WHERE uid = ? LIMIT 1',
    [uid]
  );
  const authoritative = pt ? Number(pt.smb) : null;
  const traceable = Number(s.totalCreditedIncome || 0);
  console.log('────────────────────────────────────────────────────────');
  console.log(`[reconcile] authoritative ttlincome2 = ${authoritative}`);
  console.log(`[reconcile] traceable (this trace)   = ${traceable}`);
  if (authoritative != null) {
    const gap = authoritative - traceable;
    console.log(`[reconcile] gap = ${gap} (${authoritative ? ((traceable / authoritative) * 100).toFixed(2) : '0'}% traced)`);
    if (Math.abs(gap) < 1) {
      console.log('[reconcile] ✅ penny-perfect — full lifetime SMB is now event-traceable.');
    } else {
      console.log('[reconcile] ⚠ gap remains — inspect eligible source coverage / leg balances.');
    }
  }
  console.log('────────────────────────────────────────────────────────');

  await pool.end();
}

main().catch((err) => {
  console.error('[rebuild_pairing_trace] FAILED:', err);
  process.exit(1);
});
