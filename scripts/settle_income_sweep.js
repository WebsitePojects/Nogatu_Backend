/**
 * settle_income_sweep.js — nightly sweep that invokes the EXISTING idempotent income engine
 * (calculateAndStoreIncome) for every member, so members who never personally load their
 * dashboard/wallet still get their earned income credited ("stranded income").
 *
 * Income types 1 (direct referral), 2 (pairing/SMB), 3 (leadership), 4 (unilevel, monthly-gated),
 * and 5 (hi-five package auto-credit) currently only recompute+persist when the member's own
 * request hits routes/dashboard.js or routes/wallet.js, both of which just call:
 *
 *     calculateAndStoreIncome(uid, accttype)
 *
 * This script contains ZERO income math of its own. It is pure orchestration: page through
 * usertab, call the same function the dashboard/wallet routes already call, and report what
 * it credited. Every safety property already lives in the engine, not here:
 *   - services/income/calculateAndStoreIncome.js takes a per-uid GET_LOCK, so a concurrent
 *     dashboard/wallet load for the same member cannot race with this sweep.
 *   - Every income type is reconciled monotonically against payouttotaltab.ttlincomeN via
 *     Math.max(0, entitlement - stored) — re-running (this sweep, twice in a row, or overlapping
 *     with a live login) is always a no-op past what is actually owed. Never double-pays.
 *   - The credit + balance update happens inside the engine's own transaction with
 *     `SELECT ... FOR UPDATE` on payouttotaltab, so it can't lose a concurrent encashment debit.
 *
 * FIRST LINES MUST load the backend env BEFORE requiring config/database (or any service that
 * requires it) — config/database.js builds its mysql pool from process.env AT REQUIRE TIME, and
 * its own fallback default ('nogatualliance_sysdb') is the PROD db name. Requiring it before env
 * vars are loaded is the exact "looks like prod but is the unconfigured fallback" trap recorded
 * in .claude/rules/lessons.md. loadBackendEnv() also throws loudly if the target env file is
 * missing, instead of silently falling through to that default.
 *
 *   GREEN (staging): node scripts/settle_income_sweep.js --commit
 *   BLUE  (prod):    NODE_ENV=production node scripts/settle_income_sweep.js --commit
 *
 * DRY-RUN BY DEFAULT — without --commit this script only counts members it WOULD process. It
 * never requires calculateAndStoreIncome and never opens a transaction in that mode.
 */
'use strict';

const DEFAULTS = Object.freeze({
  batchSize: 200,
  sleepMs: 250,
  startUid: 0,
  maxMembers: 0, // 0 = unlimited
});

// Systemic-failure circuit breaker: this many consecutive per-member errors aborts the whole
// run rather than silently grinding through a broken DB/engine for the rest of the table.
const ABORT_THRESHOLD = 25;

// The six authoritative lifetime income totals on payouttotaltab. Diffing these (not computing
// them) is the only "money-shaped" logic in this file, and it is read-only comparison, never a
// credit decision — the credit decision already happened inside calculateAndStoreIncome().
const INCOME_FIELDS = ['ttlincome1', 'ttlincome2', 'ttlincome3', 'ttlincome4', 'ttlincome5', 'ttlincome6'];

/**
 * Parse CLI args into a plain options object. Pure function — no I/O, no env access, safe to
 * unit-test without touching a database.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 */
function parseSweepArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];

  const flag = (name) => args.includes(`--${name}`);
  const val = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const positiveInt = (raw, fallback, { allowZero = false } = {}) => {
    if (raw === null || raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const floored = Math.floor(n);
    if (allowZero ? floored < 0 : floored <= 0) return fallback;
    return floored;
  };

  const help = flag('help') || args.includes('-h');
  const commit = flag('commit');

  const batchSize = positiveInt(val('batch-size'), DEFAULTS.batchSize);
  const sleepMs = positiveInt(val('sleep-ms'), DEFAULTS.sleepMs, { allowZero: true });
  const startUid = positiveInt(val('start-uid'), DEFAULTS.startUid, { allowZero: true });
  const maxMembers = positiveInt(val('max-members'), DEFAULTS.maxMembers, { allowZero: true });

  const onlyUidsRaw = val('only-uids');
  let onlyUids = null;
  if (onlyUidsRaw !== null && onlyUidsRaw !== '') {
    onlyUids = onlyUidsRaw
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  return { help, commit, batchSize, sleepMs, startUid, maxMembers, onlyUids };
}

/** Pure circuit-breaker check — testable without touching the loop that calls it. */
function shouldAbort(consecutiveErrors) {
  return Number(consecutiveErrors || 0) >= ABORT_THRESHOLD;
}

/**
 * Read-only diff of the authoritative income totals before vs. after an engine call. NOT a
 * credit computation — the credit already happened (or didn't) inside calculateAndStoreIncome().
 * This only decides what to print/tally for the run summary.
 * @returns {{anyCredited: boolean, deltas: Record<string, number>}}
 */
function diffCredited(before, after) {
  const deltas = {};
  let anyCredited = false;
  for (const field of INCOME_FIELDS) {
    const b = Number(before?.[field] || 0);
    const a = Number(after?.[field] || 0);
    const d = Number((a - b).toFixed(2));
    if (d > 0) {
      deltas[field] = d;
      anyCredited = true;
    }
  }
  return { anyCredited, deltas };
}

function formatHelp() {
  return [
    'settle_income_sweep.js — nightly sweep invoking the EXISTING idempotent income engine',
    '(calculateAndStoreIncome) for every member, so pairing/leadership/direct-referral/hi-five',
    'income no longer waits for the member to personally load their dashboard/wallet.',
    '',
    'This script has ZERO income math of its own. It only calls the existing engine and reports',
    'what it credited. All money-safety guarantees (per-uid GET_LOCK, Math.max monotonic',
    'reconciliation, own transaction + FOR UPDATE) live inside calculateAndStoreIncome() already.',
    '',
    'Usage:',
    '  node scripts/settle_income_sweep.js [--commit] [options]',
    '',
    'Modes:',
    '  (no flag)   DRY-RUN (default) — counts members that would be processed. Never calls the',
    '              engine, never opens a DB transaction, never writes anything.',
    '  --commit    Actually invoke calculateAndStoreIncome(uid, accttype) per member and persist',
    '              any newly-owed income (same write path as a dashboard/wallet page load).',
    '',
    'Options:',
    '  --batch-size N     Members fetched per DB page (keyset pagination). Default 200.',
    '  --sleep-ms M       Pause between members in ms — load throttle for the shared DB.',
    '                     Default 250. Use --sleep-ms 0 to disable.',
    '  --start-uid U      Resume point: only process uid > U. Default 0 (start from the top).',
    '  --max-members K    Safety cap on members scanned this run. Default 0 (unlimited).',
    '  --only-uids a,b,c  Targeted run: process only these uids, ignoring pagination/start-uid.',
    '  --help, -h         Print this help and exit. Does not touch the database.',
    '',
    'Examples:',
    '  node scripts/settle_income_sweep.js                                   # dry-run, full table',
    '  node scripts/settle_income_sweep.js --commit --max-members 500',
    '  node scripts/settle_income_sweep.js --commit --only-uids 155253,1961878',
    '  node scripts/settle_income_sweep.js --commit                          # GREEN (staging)',
    '  NODE_ENV=production node scripts/settle_income_sweep.js --commit     # BLUE (prod)',
    '',
  ].join('\n');
}

function newStats(startUid) {
  const creditedByType = {};
  for (const f of INCOME_FIELDS) creditedByType[f] = 0;
  return {
    scanned: 0,
    credited: 0,
    errors: 0,
    consecutiveErrors: 0,
    creditedByType,
    lastUid: Number(startUid || 0),
  };
}

function printSummary(stats, startedAt, parsed, stopReason) {
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const lines = [];
  lines.push('');
  lines.push('[income-sweep] ── summary ──────────────────────────────');
  lines.push(`  mode:               ${parsed.commit ? 'COMMIT' : 'DRY-RUN'}`);
  lines.push(`  members scanned:    ${stats.scanned}`);
  lines.push(`  members credited:   ${stats.credited}`);
  for (const field of INCOME_FIELDS) {
    const amount = stats.creditedByType[field] || 0;
    if (amount > 0) lines.push(`    ${field.replace('ttlincome', 'income')}: +${amount.toFixed(2)}`);
  }
  lines.push(`  errors:             ${stats.errors}`);
  lines.push(`  elapsed:            ${elapsedSec}s`);
  lines.push(`  last uid processed: ${stats.lastUid}`);
  if (stopReason) lines.push(`  stopped early:      ${stopReason}`);
  lines.push(`  resume with:        --start-uid ${stats.lastUid}`);
  lines.push('[income-sweep] ─────────────────────────────────────────');
  console.log(lines.join('\n'));
}

module.exports = {
  DEFAULTS,
  ABORT_THRESHOLD,
  INCOME_FIELDS,
  parseSweepArgs,
  shouldAbort,
  diffCredited,
  formatHelp,
  newStats,
};

// ── Everything below touches the network/DB and only runs when this file is executed ────────
// directly (never on require()), so tests can pull the pure helpers above with zero DB risk.
if (require.main === module) {
  main().catch((err) => {
    console.error('[income-sweep] FATAL:', err);
    process.exit(1);
  });
}

async function main() {
  const parsed = parseSweepArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(formatHelp());
    process.exit(0);
    return;
  }

  // Lazy require: loadBackendEnv() must run and populate process.env BEFORE config/database (or
  // any service that pulls it in transitively) is ever required. See file header + lessons.md.
  const { loadBackendEnv, getDbConfig } = require('./env');
  loadBackendEnv();
  const dbConfig = getDbConfig();

  // Header line FIRST, before any query runs, so an operator can Ctrl-C before damage.
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${dbConfig.user}@${dbConfig.host}/${dbConfig.database}`);

  const { pool } = require('../config/database');
  // Only needed in --commit mode, but requiring it is cheap and side-effect-free (no DB call at
  // require time) — kept alongside pool for clarity of what --commit mode touches.
  const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');

  console.log(
    `[income-sweep] mode=${parsed.commit ? 'COMMIT' : 'DRY-RUN'} batchSize=${parsed.batchSize} ` +
    `sleepMs=${parsed.sleepMs} startUid=${parsed.startUid} maxMembers=${parsed.maxMembers || 'unlimited'}` +
    `${parsed.onlyUids && parsed.onlyUids.length ? ` onlyUids=${parsed.onlyUids.join(',')}` : ''}`
  );

  let shuttingDown = false;
  const requestShutdown = (sig) => {
    if (shuttingDown) return; // second signal — let the process die on its own if truly stuck
    console.log(`\n[income-sweep] received ${sig} — finishing current member, then stopping...`);
    shuttingDown = true;
  };
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();
  const stats = newStats(parsed.startUid);
  let stopReason = null; // null | 'shutdown' | 'consecutive-errors' | null (ran to completion)

  /**
   * Process one page of { uid, currentaccttype, accttype } rows. Returns true if the caller
   * should stop fetching further pages (abort or shutdown requested mid-page).
   */
  async function processPage(rows) {
    for (const row of rows) {
      if (shuttingDown) { stopReason = 'shutdown'; return true; }
      if (parsed.maxMembers && stats.scanned >= parsed.maxMembers) { stopReason = stopReason || 'max-members'; return true; }

      const uid = Number(row.uid);
      stats.scanned += 1;
      stats.lastUid = uid;

      if (!parsed.commit) {
        // DRY RUN: count only. Never calls the engine, never opens a connection beyond the
        // page-fetch query already issued by the caller.
        if (stats.scanned % 1000 === 0) {
          console.log(`  ...scanned ${stats.scanned} (dry-run, no engine calls)`);
        }
        continue;
      }

      const accttype = Number(row.currentaccttype || row.accttype || 0);
      try {
        // Best-effort "before" snapshot for the summary log only — it does not gate or compute
        // any credit decision, so a benign race with a concurrent dashboard/wallet load (which
        // takes its OWN GET_LOCK inside calculateAndStoreIncome) can at most misattribute a
        // logged delta between "this sweep" and "a concurrent login"; it can never cause a
        // double or missed credit, because the actual write path is entirely inside the engine.
        // eslint-disable-next-line no-await-in-loop
        const [beforeRows] = await pool.query(
          'SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6 FROM payouttotaltab WHERE uid = ?',
          [uid]
        );
        const before = beforeRows[0] || {};

        // eslint-disable-next-line no-await-in-loop
        const after = await calculateAndStoreIncome(uid, accttype);

        // Corruption/tamper canary: the engine is monotonic (ttlincomeN = ttlincomeN + delta,
        // delta >= 0), so an authoritative total DECREASING across an engine call is impossible
        // through any legitimate path. Alert loudly; never mask it in the summary.
        for (const field of INCOME_FIELDS) {
          const dropped = Number(after?.[field] || 0) - Number(before?.[field] || 0);
          if (dropped < -0.005) {
            console.error(
              `[income-sweep] !!! NEGATIVE DELTA uid=${uid} ${field}: ${Number(before?.[field] || 0)} -> ${Number(after?.[field] || 0)} — monotonic total went DOWN, investigate immediately`
            );
          }
        }

        const { anyCredited, deltas } = diffCredited(before, after || {});
        if (anyCredited) {
          stats.credited += 1;
          for (const [field, amount] of Object.entries(deltas)) {
            stats.creditedByType[field] = Number((stats.creditedByType[field] + amount).toFixed(2));
          }
          const parts = Object.entries(deltas)
            .map(([f, a]) => `${f.replace('ttlincome', 'income')}=+${a}`)
            .join(', ');
          console.log(`uid=${uid} credited: ${parts}`);
        }
        stats.consecutiveErrors = 0;
      } catch (err) {
        stats.errors += 1;
        stats.consecutiveErrors += 1;
        console.error(`uid=${uid} ERROR: ${err && err.message ? err.message : err}`);
        if (shouldAbort(stats.consecutiveErrors)) {
          console.error(
            `[income-sweep] ABORT: ${stats.consecutiveErrors} consecutive member errors — ` +
            'systemic failure signal, stopping the run.'
          );
          stopReason = 'consecutive-errors';
          return true;
        }
      }

      if (stats.scanned % 500 === 0) {
        console.log(`  ...processed ${stats.scanned} (credited=${stats.credited}, errors=${stats.errors})`);
      }

      if (parsed.sleepMs > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(parsed.sleepMs);
      }
    }
    return false;
  }

  try {
    if (parsed.onlyUids && parsed.onlyUids.length > 0) {
      const targets = parsed.maxMembers ? parsed.onlyUids.slice(0, parsed.maxMembers) : parsed.onlyUids;
      const placeholders = targets.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT uid, currentaccttype, accttype FROM usertab WHERE uid IN (${placeholders}) ORDER BY uid ASC`,
        targets
      );
      await processPage(rows);
    } else {
      let cursor = parsed.startUid;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (shuttingDown) { stopReason = stopReason || 'shutdown'; break; }
        if (parsed.maxMembers && stats.scanned >= parsed.maxMembers) { stopReason = stopReason || 'max-members'; break; }

        const remaining = parsed.maxMembers ? parsed.maxMembers - stats.scanned : 0;
        const pageSize = parsed.maxMembers ? Math.max(0, Math.min(parsed.batchSize, remaining)) : parsed.batchSize;
        if (pageSize <= 0) break;

        // Keyset pagination (uid > cursor), never OFFSET — stays fast and correct even as the
        // table grows across runs. `uid = mainid` matches the convention every other batch job
        // in this repo uses when iterating "real" member accounts (services/ranking.js,
        // services/globalBonus.js, routes/leaderboard.js, scripts/settle_unilevel_month.js, ...).
        // Every usertab row currently satisfies uid == mainid (set once at registration and
        // never reassigned — verified against the schema and data), so this is a no-op today;
        // it is kept as free, convention-matching defense-in-depth against future data drift.
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await pool.query(
          'SELECT uid, currentaccttype, accttype FROM usertab u WHERE u.uid > ? AND u.uid = u.mainid ORDER BY u.uid ASC LIMIT ?',
          [cursor, pageSize]
        );
        if (rows.length === 0) break;

        cursor = Number(rows[rows.length - 1].uid);

        // eslint-disable-next-line no-await-in-loop
        const stop = await processPage(rows);
        if (stop) break;
        if (rows.length < pageSize) break; // last page
      }
    }
  } finally {
    printSummary(stats, startedAt, parsed, stopReason);
    await pool.end();
  }

  process.exit(stopReason === 'consecutive-errors' ? 1 : 0);
}
