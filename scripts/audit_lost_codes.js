/**
 * READ-ONLY ACTIVATION-CODE ANOMALY DETECTOR.
 *
 * Finds anomalies in codestab:
 *
 *   CHECK-A  codestatus=2 (Used) but uid IS NULL — code marked used with no member attached
 *   CHECK-B  codestatus=2 (Used) but uid points to a uid NOT in memberstab — orphaned used code
 *   CHECK-C  codestatus=2 (Used) but dateused IS NULL — inconsistent used state
 *   CHECK-D  codestatus=2 (Used) but uid points to a uid NOT in usertab — used, member exists
 *            in memberstab but has no usertab row (tree linkage gap)
 *   CHECK-E  codestatus=1 (Available/Released), uid IS set, but uid not in memberstab — dangling transfer target
 *            (NOTE: codestatus=1 with uid=NULL is NORMAL — the release step does not set uid;
 *             uid is only set by an explicit admin transfer. So we only flag when uid IS set but missing.)
 *   CHECK-F  codestatus=1 or 2 but dategen IS NULL — codes with no generation date
 *   CHECK-G  codestatus=0 (Not Released) but dateused IS NOT NULL — unreleased but has a use date
 *   CHECK-H  duplicate code strings (same code value appears more than once)
 *
 * Outputs a table per check and summary counts.
 *
 * Usage (green staging, no NODE_ENV prefix):
 *   node scripts/audit_lost_codes.js [--csv]
 *
 * READ-ONLY. No writes. Safe on green or blue.
 *
 * codestatus semantics (from routes/admin/codes.js + routes/codes.js):
 *   0 = Not Released / For Release (generated, not yet assigned to anyone)
 *   1 = Released / Available (assigned, ready to use)
 *   2 = Used (redeemed — uid updated to registrant, dateused set)
 */

'use strict';

const { loadBackendEnv, getDbConfig } = require('./env');

function parseArgs () {
  const opt = { csv: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--csv') opt.csv = true;
  }
  return opt;
}

async function main () {
  const opt = parseArgs();
  const envFile = loadBackendEnv();
  const cfg     = getDbConfig();
  console.log(`\n[audit_lost_codes] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log('Checks: used-no-member, used-orphaned-uid, missing-dateused, used-no-usertab, released-dangling-uid, active-no-dategen, unreleased-with-dateused, duplicate codes.\n');

  const { pool } = require('../config/database');

  // ── CHECK-A: codestatus=2 but uid IS NULL ─────────────────────────────────────
  const [checkA] = await pool.query(
    `SELECT id, code, producttype, codetype, codestatus, uid, dateused, dategen, processid,
            'Used (codestatus=2) but uid is NULL' AS reason
       FROM codestab
      WHERE codestatus = 2 AND (uid IS NULL OR uid = 0)
      ORDER BY dateused DESC`
  );

  // ── CHECK-B: codestatus=2, uid set, but uid not in memberstab ────────────────
  const [checkB] = await pool.query(
    `SELECT c.id, c.code, c.producttype, c.codetype, c.codestatus, c.uid,
            c.dateused, c.dategen, c.processid,
            'Used (codestatus=2) but uid not in memberstab (orphaned member)' AS reason
       FROM codestab c
      WHERE c.codestatus = 2
        AND c.uid IS NOT NULL AND c.uid != 0
        AND NOT EXISTS (SELECT 1 FROM memberstab m WHERE m.uid = c.uid)
      ORDER BY c.dateused DESC`
  );

  // ── CHECK-C: codestatus=2 but dateused IS NULL ────────────────────────────────
  const [checkC] = await pool.query(
    `SELECT id, code, producttype, codetype, codestatus, uid, dateused, dategen, processid,
            'Used (codestatus=2) but dateused is NULL' AS reason
       FROM codestab
      WHERE codestatus = 2 AND dateused IS NULL
      ORDER BY dategen DESC`
  );

  // ── CHECK-D: codestatus=2, uid in memberstab but NOT in usertab ──────────────
  const [checkD] = await pool.query(
    `SELECT c.id, c.code, c.producttype, c.codetype, c.codestatus, c.uid,
            c.dateused, c.dategen, c.processid,
            'Used (codestatus=2): uid in memberstab but NOT in usertab (no tree linkage)' AS reason
       FROM codestab c
      WHERE c.codestatus = 2
        AND c.uid IS NOT NULL AND c.uid != 0
        AND EXISTS     (SELECT 1 FROM memberstab m WHERE m.uid = c.uid)
        AND NOT EXISTS (SELECT 1 FROM usertab u   WHERE u.uid = c.uid)
      ORDER BY c.dateused DESC`
  );

  // ── CHECK-E: codestatus=1, uid IS NOT NULL, but uid not in memberstab ───────
  // The release step does NOT set uid — uid stays NULL until an admin transfers
  // the code to a member.  So uid=NULL on a released code is normal (unassigned).
  // The anomaly is: uid IS set (code was transferred to someone) but that
  // someone no longer exists in memberstab — a dangling transfer target.
  const [checkE] = await pool.query(
    `SELECT c.id, c.code, c.producttype, c.codetype, c.codestatus, c.uid,
            c.dateused, c.dategen, c.processid,
            'Released (codestatus=1): uid set but that uid not in memberstab (dangling transfer target)' AS reason
       FROM codestab c
      WHERE c.codestatus = 1
        AND c.uid IS NOT NULL AND c.uid != 0
        AND NOT EXISTS (SELECT 1 FROM memberstab m WHERE m.uid = c.uid)
      ORDER BY c.dategen DESC`
  );

  // ── CHECK-F: codestatus in (1,2) but dategen IS NULL ─────────────────────────
  const [checkF] = await pool.query(
    `SELECT id, code, producttype, codetype, codestatus, uid, dateused, dategen, processid,
            'Active/Used code (codestatus=1 or 2) but dategen is NULL' AS reason
       FROM codestab
      WHERE codestatus IN (1, 2) AND dategen IS NULL
      ORDER BY id DESC`
  );

  // ── CHECK-G: codestatus=0 but dateused IS NOT NULL ───────────────────────────
  const [checkG] = await pool.query(
    `SELECT id, code, producttype, codetype, codestatus, uid, dateused, dategen, processid,
            'Not-Released (codestatus=0) but dateused is NOT NULL — state inconsistency' AS reason
       FROM codestab
      WHERE codestatus = 0 AND dateused IS NOT NULL
      ORDER BY dateused DESC`
  );

  // ── CHECK-H: duplicate code strings ──────────────────────────────────────────
  // A code string appearing more than once — regardless of status — is a data integrity risk.
  const [checkHDups] = await pool.query(
    `SELECT code, COUNT(*) AS cnt
       FROM codestab
      GROUP BY code
     HAVING cnt > 1
      ORDER BY cnt DESC, code`
  );

  // Expand duplicates to show full rows for each duplicated code string
  let checkH = [];
  for (const dup of checkHDups) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await pool.query(
      `SELECT id, code, producttype, codetype, codestatus, uid, dateused, dategen, processid,
              CONCAT('Duplicate code string (appears ', ?, ' times)') AS reason
         FROM codestab WHERE code = ? ORDER BY id`,
      [dup.cnt, dup.code]
    );
    checkH = checkH.concat(rows);
  }

  // ── Collate all findings ──────────────────────────────────────────────────────
  const sections = [
    { label: 'A — Used, uid NULL',                 rows: checkA },
    { label: 'B — Used, uid not in memberstab',    rows: checkB },
    { label: 'C — Used, dateused NULL',            rows: checkC },
    { label: 'D — Used, uid in memberstab but not usertab', rows: checkD },
    { label: 'E — Released, uid set but not in memberstab (dangling transfer)', rows: checkE },
    { label: 'F — Active/Used, dategen NULL',      rows: checkF },
    { label: 'G — Not-Released, dateused not NULL',rows: checkG },
    { label: 'H — Duplicate code strings',         rows: checkH },
  ];

  const totalFlagged = sections.reduce((s, x) => s + x.rows.length, 0);

  const pad = (v, n) => String(v === null || v === undefined ? 'NULL' : v).padEnd(n);

  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  ACTIVATION CODE ANOMALY REPORT');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Total flagged codes: ${totalFlagged}`);
  console.log('  ── Counts per check ──');
  for (const s of sections) {
    const marker = s.rows.length > 0 ? '!!' : 'OK';
    console.log(`    [${String(s.rows.length).padStart(5)}]  [${marker}]  ${s.label}`);
  }
  console.log('');

  for (const s of sections) {
    if (s.rows.length === 0) {
      console.log(`[${s.label}]  CLEAN — no anomalies found.`);
      continue;
    }
    console.log(`\n[${s.label}]  ${s.rows.length} anomaly/ies:`);
    console.log(
      pad('id', 8) + pad('code', 14) + pad('ptype', 7) + pad('ctype', 7) +
      pad('status', 8) + pad('uid', 12) + pad('dategen', 22) + pad('dateused', 22) + 'reason'
    );
    console.log('─'.repeat(140));
    for (const r of s.rows) {
      const statusLabel = r.codestatus === 0 ? '0=NoRel' : r.codestatus === 1 ? '1=Avail' : r.codestatus === 2 ? '2=Used' : String(r.codestatus);
      console.log(
        pad(r.id, 8) + pad(r.code, 14) + pad(r.producttype, 7) + pad(r.codetype, 7) +
        pad(statusLabel, 8) + pad(r.uid, 12) +
        pad(r.dategen  ? String(r.dategen).slice(0,19)  : 'NULL', 22) +
        pad(r.dateused ? String(r.dateused).slice(0,19) : 'NULL', 22) +
        r.reason
      );
    }
  }

  if (opt.csv) {
    console.log('\n─── CSV (check,id,code,producttype,codetype,codestatus,uid,dategen,dateused,reason) ───');
    for (const s of sections) {
      for (const r of s.rows) {
        console.log([
          s.label, r.id, r.code, r.producttype, r.codetype, r.codestatus, r.uid,
          r.dategen  ? String(r.dategen).slice(0,19)  : '',
          r.dateused ? String(r.dateused).slice(0,19) : '',
          r.reason,
        ].join(','));
      }
    }
  }

  console.log('\n[audit_lost_codes] Read-only — nothing was written.\n');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
