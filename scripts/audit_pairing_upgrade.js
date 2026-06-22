/**
 * READ-ONLY audit: legacy upgrades that never produced a binary (SMB) event.
 *
 * Hypothesis (Minutes #5 — Ashanti / Primavesa "no sales match, di pumapalo kay Elmer"):
 * accounts that upgraded from a lower tier to Gold/Garnet IN THE OLD PHP SYSTEM did not
 * create an `upgradetab` (transtype=1) row in the new system. The new pairing engine sources
 * upgrade binary points ONLY from `upgradetab WHERE transtype=1` (services/income/pairing.js
 * + pairingTracker.js), so that upgrade's binary delta is never credited to the binary upline
 * (Elmer) → understated leg totals → missing sales-match commission.
 *
 * For each account it reports, per money-integrity (REPORT, never auto-credit):
 *   expected_binary = binaryValue(currentaccttype)           [250/500/1000/2500/5000/15000]
 *   stored_binary   = usertab.binarypoints + Σ upgradetab(transtype=1).binarypoints
 *   GAP             = expected - stored   (GAP > 0 on an UPGRADED account = the legacy-upgrade
 *                     binary that the engine never credits upstream)
 * plus eligibility as a binary SOURCE node (PD / fully-paid CD contribute; FS / unpaid-CD do not),
 * binary parent (refid/position), and registration date (legacy vs new-system inference).
 *
 * It also SCANS the binary subtree under Elmer (refid descent) for every upgraded account with
 * GAP > 0 — i.e. exactly the "2 Gold / 2 Garnet" culprits that should pay Elmer but don't.
 *
 * Usage (BLUE / prod, read-only):
 *   NODE_ENV=production node scripts/audit_pairing_upgrade.js
 *   NODE_ENV=production node scripts/audit_pairing_upgrade.js 330766 7266942 6122895
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

// 250-based binaryValue per package code (services/packagePolicy.js). usertab.binarypoints
// stores this value; total binary contribution = base + Σ upgrade deltas.
const BINARY_VALUE = { 10: 250, 20: 500, 30: 1000, 40: 2500, 50: 5000, 60: 15000 };
const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };

// Default subjects: Ashanti01, Primavesa01, Elmer143 (binary upline named in Minutes #5).
const DEFAULT_UIDS = [330766, 7266942, 6122895];
const ELMER_UID = 6122895;

function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

function sourceEligibility(codeid, cdstatus) {
  const c = num(codeid);
  const cd = num(cdstatus);
  if (c === 1) return 'PD — contributes';
  if (c === 3 && cd === 2) return 'CD fully-paid — contributes';
  if (c === 3) return 'CD unpaid — does NOT contribute';
  if (c === 2) return 'FS — does NOT contribute (can earn, not source)';
  return `codeid=${c} — unknown`;
}

async function loadAccount(conn, uid) {
  const [[u]] = await conn.query(
    `SELECT u.uid, u.refid, u.position, u.drefid, u.accttype, u.currentaccttype,
            u.codeid, u.cdstatus, u.binarypoints, u.activedate,
            m.username, m.firstname, m.lastname
       FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = ? LIMIT 1`,
    [uid]
  );
  if (!u) return null;
  const [ups] = await conn.query(
    `SELECT id, producttype, binarypoints, transtype, transdate
       FROM upgradetab WHERE uid = ? AND transtype = 1 ORDER BY id ASC`,
    [uid]
  );
  const [[pay]] = await conn.query(
    'SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]
  );
  return { u, ups, pairingEarned: num(pay?.ttlincome2) };
}

function gapFor(u, upgradePts) {
  const expected = num(BINARY_VALUE[num(u.currentaccttype)]);
  const stored = num(u.binarypoints) + num(upgradePts);
  return { expected, stored, gap: expected - stored };
}

async function auditAccount(conn, uid) {
  const data = await loadAccount(conn, uid);
  if (!data) { console.log(`\n===== uid ${uid} — NOT FOUND =====`); return; }
  const { u, ups, pairingEarned } = data;
  const upPts = ups.reduce((s, r) => s + num(r.binarypoints), 0);
  const { expected, stored, gap } = gapFor(u, upPts);
  const upgraded = num(u.currentaccttype) > num(u.accttype);

  console.log(`\n===== ${u.username} (uid ${u.uid}, ${(u.firstname || '') + ' ' + (u.lastname || '')}) =====`);
  console.log(`  package: registered ${PKG[num(u.accttype)] || u.accttype} -> current ${PKG[num(u.currentaccttype)] || u.currentaccttype}  ${upgraded ? '(UPGRADED)' : '(no upgrade)'}`);
  console.log(`  binary source eligibility: ${sourceEligibility(u.codeid, u.cdstatus)}`);
  console.log(`  binary parent (refid): ${num(u.refid)}  position: ${u.position || '-'}   sponsor (drefid): ${num(u.drefid)}`);
  console.log(`  registered: ${u.activedate || '-'}`);
  console.log(`  usertab.binarypoints (base): ${num(u.binarypoints)}`);
  console.log(`  upgradetab transtype=1 rows: ${ups.length}${ups.length ? ` (Σ binarypoints ${upPts})` : ''}`);
  for (const r of ups) console.log(`      - id ${r.id} producttype ${r.producttype} binarypoints ${num(r.binarypoints)} @ ${r.transdate || '-'}`);
  console.log(`  EXPECTED binary for ${PKG[num(u.currentaccttype)] || u.currentaccttype}: ${expected}   STORED (base+upgrades): ${stored}   GAP: ${gap}`);
  console.log(`  ttlincome2 (lifetime SMB earned by THIS account): ${pairingEarned}`);
  if (upgraded && gap > 0) {
    console.log(`  >>> FINDING: legacy upgrade binary NOT credited — under-contributes ${gap} binary value to its upline's pairing.`);
  } else if (gap > 0) {
    console.log(`  >>> NOTE: GAP ${gap} but currentaccttype not > accttype — confirm package fields before concluding.`);
  } else if (gap < 0) {
    console.log(`  >>> NOTE: stored EXCEEDS expected by ${-gap} — possible double-counted upgrade; investigate before trusting.`);
  } else {
    console.log(`  >>> OK: binary contribution matches the current package.`);
  }
}

async function scanBinarySubtree(conn, ancestorUid) {
  console.log(`\n========== SCAN: upgraded accounts with GAP>0 in the binary subtree of uid ${ancestorUid} (Elmer) ==========`);
  let rows;
  try {
    [rows] = await conn.query(
      `WITH RECURSIVE bt AS (
         SELECT uid, refid, 0 AS d FROM usertab WHERE uid = ?
         UNION ALL
         SELECT c.uid, c.refid, b.d + 1 FROM bt b JOIN usertab c ON c.refid = b.uid AND c.uid <> b.uid
          WHERE b.d < 50
       )
       SELECT bt.uid, bt.d AS depth, m.username, u.accttype, u.currentaccttype,
              u.codeid, u.cdstatus, u.binarypoints,
              COALESCE(up.up_pts,0) AS up_pts, COALESCE(up.up_cnt,0) AS up_cnt
         FROM bt
         JOIN usertab u ON u.uid = bt.uid
         LEFT JOIN memberstab m ON m.uid = bt.uid
         LEFT JOIN (SELECT uid, SUM(binarypoints) AS up_pts, COUNT(*) AS up_cnt
                      FROM upgradetab WHERE transtype = 1 GROUP BY uid) up ON up.uid = bt.uid
        WHERE bt.d > 0`,
      [ancestorUid]
    );
  } catch (e) {
    console.log(`  (subtree scan skipped: ${e.message})`);
    return;
  }
  let flagged = 0;
  let totalGap = 0;
  for (const r of rows) {
    const expected = num(BINARY_VALUE[num(r.currentaccttype)]);
    const stored = num(r.binarypoints) + num(r.up_pts);
    const gap = expected - stored;
    const upgraded = num(r.currentaccttype) > num(r.accttype);
    if (upgraded && gap > 0) {
      flagged += 1;
      totalGap += gap;
      console.log(`  GAP ${gap}  uid ${r.uid} ${r.username || ''}  ${PKG[num(r.accttype)] || r.accttype}->${PKG[num(r.currentaccttype)] || r.currentaccttype}  base ${num(r.binarypoints)} +upg ${num(r.up_pts)} (${num(r.up_cnt)} rows)  ${sourceEligibility(r.codeid, r.cdstatus)}`);
    }
  }
  console.log(`  subtree size: ${rows.length} descendants. FLAGGED (upgraded + GAP>0): ${flagged}. Total un-credited binary value: ${totalGap}.`);
  console.log('  NOTE: only flagged accounts that are ELIGIBLE SOURCE nodes (PD / fully-paid CD) actually move Elmer\'s legs; FS / unpaid-CD would not contribute even if credited.');
}

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`[pairing:audit] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);

  const argvUids = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const targets = argvUids.length ? argvUids : DEFAULT_UIDS;

  const conn = await mysql.createConnection(cfg);
  try {
    for (const uid of targets) {
      // eslint-disable-next-line no-await-in-loop
      await auditAccount(conn, uid);
    }
    await scanBinarySubtree(conn, ELMER_UID);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[pairing:audit] FAILED:', err.message);
  process.exit(1);
});
