/**
 * READ-ONLY pairing entitlement diagnostic.
 *
 * Management states Primavesa & Elmer did NOT receive the pairing (SMB) they are entitled to.
 * This runs the ACTUAL engine (services/income/pairing.getPairing — read-only; it computes and
 * returns, it does NOT write) for each member and compares the engine's computed totalPay against
 * the already-paid authoritative total (payouttotaltab.ttlincome2). Per money-integrity, when the
 * two disagree THAT is the finding:
 *
 *   engine.totalPay > ttlincome2  -> OWED / uncredited pairing the member should receive
 *                                    (the monotonic engine would credit max(0, diff) on wallet load).
 *   engine.totalPay < ttlincome2  -> legacy-heavy: the engine can only reconstruct part of the
 *                                    pre-import history, so paid > engine is EXPECTED for legacy
 *                                    leaders and is NOT proof of a shortfall by itself.
 *
 * Also prints leg point totals + matched points so a leg imbalance (weak-leg constraint) is visible.
 * Writes nothing.
 *
 * Usage (BLUE / prod):
 *   NODE_ENV=production node scripts/diag_pairing_owed.js                 # Primavesa + Elmer
 *   NODE_ENV=production node scripts/diag_pairing_owed.js 7266942 6122895 330766
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const { getPairing } = require('../services/income/pairing');
const { getEffectiveAccountState } = require('../services/accountState');

const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

async function diag(uid) {
  const [[u]] = await pool.query(
    `SELECT u.accttype, u.currentaccttype, m.username FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid WHERE u.uid = ? LIMIT 1`,
    [uid]
  );
  if (!u) { console.log(`\n===== uid ${uid} NOT FOUND =====`); return; }
  const eff = await getEffectiveAccountState(uid);
  const acct = num(eff?.currentaccttype || u.currentaccttype || u.accttype || 0);
  const [[pay]] = await pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]);
  const stored = num(pay?.ttlincome2);

  console.log(`\n===== ${u.username} (uid ${uid}, ${PKG[acct] || acct}) =====`);
  console.log('  running the real pairing engine (read-only; large trees take a moment)...');
  const t0 = Date.now();
  const r = await getPairing(uid, acct);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  eligibility.canEarnPairing: ${r.eligibility ? r.eligibility.canEarnPairing : 'n/a'}` +
    `${r.eligibility && r.eligibility.reason ? ` (${r.eligibility.reason})` : ''}`);
  console.log(`  LEFT : ${num(r.leftCount)} source nodes, ${num(r.leftPts)} pts`);
  console.log(`  RIGHT: ${num(r.rightCount)} source nodes, ${num(r.rightPts)} pts`);
  console.log(`  matched (min L,R) pairedPts: ${num(r.pairedPts)}`);
  console.log(`  ENGINE totalPay (after weekly/monthly caps): ${num(r.totalPay)}`);
  console.log(`  STORED ttlincome2 (already paid):            ${stored}`);
  const delta = num(r.totalPay) - stored;
  if (delta > 0.5) {
    console.log(`  >>> ENGINE > PAID by ${delta.toFixed(2)}  => OWED / UNCREDITED pairing. Would credit max(0,diff) on wallet load.`);
    console.log('      Confirms an entitlement the member has not received. NEXT: why not credited (wallet not loaded / blocked?).');
  } else if (delta < -0.5) {
    console.log(`  >>> PAID > ENGINE by ${(-delta).toFixed(2)}  => legacy-heavy (engine reconstructs only part of pre-import history).`);
    console.log('      This alone is NOT proof of a shortfall; leg detail / per-event review needed to judge a specific claim.');
  } else {
    console.log('  >>> engine == paid (up to date for what the engine can reconstruct).');
  }
  console.log(`  (engine run ${secs}s)`);
}

async function main() {
  console.log(`[pairowed] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const argv = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const targets = argv.length ? argv : [7266942, 6122895]; // Primavesa, Elmer
  try {
    for (const uid of targets) {
      // eslint-disable-next-line no-await-in-loop
      await diag(uid);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error('[pairowed] FAILED:', err.message); process.exit(1); });
