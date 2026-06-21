/**
 * READ-ONLY FLOATING / ORPHANED ACCOUNT DETECTOR.
 *
 * Finds members that are NOT properly attached to the network tree:
 *
 *   CHECK-1  NULL/zero/self refid (binary parent) for non-root members
 *   CHECK-2  NULL/zero/self drefid (sponsor parent) for non-root members
 *   CHECK-3  refid points to a uid that does NOT exist in memberstab (orphaned binary parent)
 *   CHECK-4  drefid points to a uid that does NOT exist in memberstab (orphaned sponsor parent)
 *   CHECK-5  member present in memberstab but with NO row in usertab at all (no tree linkage)
 *   CHECK-6  member present in usertab but with NO row in memberstab (ghost usertab entry)
 *
 * Outputs a table of flagged accounts and counts per reason.
 * Also includes a --names section for PBBJosephine, Vision01, Doodz (full diagnostic dump).
 *
 * Usage (green staging, no NODE_ENV prefix):
 *   node scripts/audit_floating_accounts.js [--names] [--csv]
 *
 * READ-ONLY. No writes. Safe on green or blue.
 */

'use strict';

const { loadBackendEnv, getDbConfig } = require('./env');

function parseArgs () {
  const opt = { names: false, csv: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--names') opt.names = true;
    if (a === '--csv')   opt.csv   = true;
  }
  return opt;
}

// Legitimate root uids: usertab rows where refid=0/NULL AND drefid=0/NULL.
// We derive these from the DB rather than hard-coding uid=1 so the script
// works on staging (different root) or future imports.
async function getRootUids (pool) {
  const [rows] = await pool.query(
    `SELECT uid FROM usertab
      WHERE (refid IS NULL OR refid = 0)
        AND (drefid IS NULL OR drefid = 0)`
  );
  return new Set(rows.map(r => Number(r.uid)));
}

async function main () {
  const opt = parseArgs();
  const envFile = loadBackendEnv();
  const cfg     = getDbConfig();
  console.log(`\n[audit_floating_accounts] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log('Checks: NULL/zero/self refid, NULL/zero/self drefid, orphaned parents, missing usertab/memberstab cross-rows.\n');

  const { pool } = require('../config/database');

  // ── CHECK-1 & CHECK-2: NULL/zero/self refid or drefid (excluding roots) ──────
  const roots = await getRootUids(pool);
  const rootList = roots.size ? [...roots].join(',') : '0';

  const [floatingRows] = await pool.query(
    `SELECT u.uid, m.username, u.accttype, u.codeid, u.refid, u.drefid, u.position, u.datereg,
            CASE
              WHEN (u.refid IS NULL OR u.refid = 0 OR u.refid = u.uid)
               AND (u.drefid IS NULL OR u.drefid = 0 OR u.drefid = u.uid)
              THEN 'NULL/zero/self BOTH refid AND drefid'
              WHEN (u.refid IS NULL OR u.refid = 0 OR u.refid = u.uid)
              THEN 'NULL/zero/self refid (binary parent)'
              ELSE 'NULL/zero/self drefid (sponsor parent)'
            END AS reason
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid NOT IN (${rootList})
        AND (
          (u.refid IS NULL OR u.refid = 0 OR u.refid = u.uid)
          OR
          (u.drefid IS NULL OR u.drefid = 0 OR u.drefid = u.uid)
        )
      ORDER BY u.datereg DESC`
  );

  // ── CHECK-3: refid points to non-existent uid in memberstab ──────────────────
  const [orphanRefRows] = await pool.query(
    `SELECT u.uid, m.username, u.accttype, u.codeid, u.refid, u.drefid, u.position, u.datereg,
            'refid points to non-existent member (orphaned binary parent)' AS reason
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.refid IS NOT NULL
        AND u.refid != 0
        AND u.refid != u.uid
        AND NOT EXISTS (SELECT 1 FROM memberstab pm WHERE pm.uid = u.refid)
      ORDER BY u.datereg DESC`
  );

  // ── CHECK-4: drefid points to non-existent uid in memberstab ─────────────────
  const [orphanDrefRows] = await pool.query(
    `SELECT u.uid, m.username, u.accttype, u.codeid, u.refid, u.drefid, u.position, u.datereg,
            'drefid points to non-existent member (orphaned sponsor parent)' AS reason
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.drefid IS NOT NULL
        AND u.drefid != 0
        AND u.drefid != u.uid
        AND NOT EXISTS (SELECT 1 FROM memberstab pm WHERE pm.uid = u.drefid)
      ORDER BY u.datereg DESC`
  );

  // ── CHECK-5: in memberstab but no usertab row ─────────────────────────────────
  const [noUsertabRows] = await pool.query(
    `SELECT m.uid, m.username,
            NULL AS accttype, NULL AS codeid,
            NULL AS refid,    NULL AS drefid,
            NULL AS position, NULL AS datereg,
            'in memberstab but NO row in usertab (no tree linkage)' AS reason
       FROM memberstab m
      WHERE NOT EXISTS (SELECT 1 FROM usertab u WHERE u.uid = m.uid)
      ORDER BY m.uid DESC`
  );

  // ── CHECK-6: in usertab but no memberstab row ─────────────────────────────────
  const [noMembersRows] = await pool.query(
    `SELECT u.uid, NULL AS username, u.accttype, u.codeid,
            u.refid, u.drefid, u.position, u.datereg,
            'in usertab but NO row in memberstab (ghost usertab entry)' AS reason
       FROM usertab u
      WHERE NOT EXISTS (SELECT 1 FROM memberstab m WHERE m.uid = u.uid)
      ORDER BY u.datereg DESC`
  );

  // ── Collate all findings ──────────────────────────────────────────────────────
  const all = [
    ...floatingRows,
    ...orphanRefRows,
    ...orphanDrefRows,
    ...noUsertabRows,
    ...noMembersRows,
  ];

  const counts = {};
  for (const r of all) {
    counts[r.reason] = (counts[r.reason] || 0) + 1;
  }

  // ── Print results ─────────────────────────────────────────────────────────────
  const pad = (v, n) => String(v === null || v === undefined ? 'NULL' : v).padEnd(n);

  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  FLOATING / ORPHANED ACCOUNT REPORT');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Total flagged accounts: ${all.length}`);
  console.log('  ── Counts per reason ──');
  for (const [reason, cnt] of Object.entries(counts)) {
    console.log(`    [${cnt}]  ${reason}`);
  }
  console.log('');

  if (all.length === 0) {
    console.log('  No floating / orphaned accounts found.\n');
  } else {
    console.log(
      pad('uid', 12) + pad('username', 20) + pad('accttype', 10) + pad('codeid', 8) +
      pad('refid', 12) + pad('drefid', 12) + pad('position', 10) + pad('datereg', 22) + 'reason'
    );
    console.log('─'.repeat(130));
    for (const r of all) {
      console.log(
        pad(r.uid, 12) + pad(r.username, 20) + pad(r.accttype, 10) + pad(r.codeid, 8) +
        pad(r.refid, 12) + pad(r.drefid, 12) + pad(r.position, 10) +
        pad(r.datereg ? String(r.datereg).slice(0, 19) : 'NULL', 22) +
        r.reason
      );
    }
  }

  if (opt.csv) {
    console.log('\n─── CSV (uid,username,accttype,codeid,refid,drefid,position,datereg,reason) ───');
    for (const r of all) {
      console.log([r.uid, r.username, r.accttype, r.codeid, r.refid, r.drefid, r.position,
        r.datereg ? String(r.datereg).slice(0, 19) : '', r.reason].join(','));
    }
  }

  // ── --names: full diagnostic for PBBJosephine, Vision01, Doodz ───────────────
  if (opt.names) {
    await dumpNamedAccounts(pool);
  }

  console.log('\n[audit_floating_accounts] Read-only — nothing was written.\n');
  await pool.end();
}

async function dumpNamedAccounts (pool) {
  const NAMES = ['PBBJosephine', 'Vision01', 'Doodz'];

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  NAMED ACCOUNT FULL DIAGNOSTIC');
  console.log('══════════════════════════════════════════════════════════════════════════════');

  for (const name of NAMES) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  Account: ${name}`);
    console.log('─'.repeat(80));

    // memberstab row
    const [memRows] = await pool.query(
      `SELECT id, uid, username, firstname, lastname, email, contactnos, tosagreement
         FROM memberstab WHERE username = ? LIMIT 5`,
      [name]
    );
    if (memRows.length === 0) {
      console.log(`  [memberstab]  NOT FOUND — username '${name}' does not exist in this DB.`);
      console.log(`  (May only exist in live prod — run on green staging after a DB refresh.)`);
      continue;
    }

    console.log(`  [memberstab]`);
    for (const r of memRows) {
      console.log(`    id=${r.id}  uid=${r.uid}  username=${r.username}  name='${r.firstname} ${r.lastname}'  email=${r.email || 'NULL'}  contact=${r.contactnos || 'NULL'}  tos=${r.tosagreement}`);
    }

    for (const mem of memRows) {
      const uid = Number(mem.uid);
      console.log(`\n  ── uid=${uid} ──`);

      // usertab row
      const [uRows] = await pool.query(
        `SELECT id, uid, refid, drefid, mainid, accttype, currentaccttype, codeid,
                activationcode, datereg, activedate, position, binarypoints,
                cdamount, cdtotal, cdstatus, status
           FROM usertab WHERE uid = ? LIMIT 1`,
        [uid]
      );
      if (uRows.length === 0) {
        console.log(`  [usertab]     NO ROW — member has no tree linkage!`);
      } else {
        const u = uRows[0];
        console.log(`  [usertab]     refid=${u.refid}  drefid=${u.drefid}  position=${u.position}`);
        console.log(`                accttype=${u.accttype}  currentaccttype=${u.currentaccttype}  codeid=${u.codeid}  activationcode=${u.activationcode}`);
        console.log(`                datereg=${u.datereg ? String(u.datereg).slice(0,19) : 'NULL'}  activedate=${u.activedate ? String(u.activedate).slice(0,19) : 'NULL'}`);
        console.log(`                binarypoints=${u.binarypoints}  cdamount=${u.cdamount}  cdtotal=${u.cdtotal}  cdstatus=${u.cdstatus}  status=${u.status}`);

        // Trace refid chain upward (up to 10 levels)
        console.log(`\n  [binary parent chain (refid)]`);
        await traceChain(pool, u.refid, 'refid', 10);

        console.log(`\n  [sponsor parent chain (drefid)]`);
        await traceChain(pool, u.drefid, 'drefid', 10);
      }

      // codestab: all codes linked to this uid
      const [codeRows] = await pool.query(
        `SELECT id, code, producttype, codetype, codestatus, dateused, dategen, processid
           FROM codestab WHERE uid = ? ORDER BY dategen DESC LIMIT 20`,
        [uid]
      );
      console.log(`\n  [codestab]    ${codeRows.length} code(s) linked to uid=${uid}`);
      for (const c of codeRows) {
        const statusLabel = c.codestatus === 0 ? 'NotReleased' : c.codestatus === 1 ? 'Available' : 'Used';
        console.log(`    id=${c.id}  code=${c.code}  producttype=${c.producttype}  codetype=${c.codetype}  status=${c.codestatus}(${statusLabel})  dategen=${c.dategen ? String(c.dategen).slice(0,19) : 'NULL'}  dateused=${c.dateused ? String(c.dateused).slice(0,19) : 'NULL'}  processid=${c.processid || 'NULL'}`);
      }

      // upgradetab rows
      const [upgRows] = await pool.query(
        `SELECT id, uid, producttype, transtype, codeid, binarypoints, transdate
           FROM upgradetab WHERE uid = ? ORDER BY transdate ASC`,
        [uid]
      );
      console.log(`\n  [upgradetab]  ${upgRows.length} upgrade row(s) for uid=${uid}`);
      for (const g of upgRows) {
        console.log(`    id=${g.id}  producttype=${g.producttype}  transtype=${g.transtype}  codeid=${g.codeid}  binarypoints=${g.binarypoints}  transdate=${g.transdate ? String(g.transdate).slice(0,19) : 'NULL'}`);
      }

      // payouttotaltab totals
      const [ptRows] = await pool.query(
        `SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome41,
                ttlincome5, ttlincome51, ttlincome6,
                ttlcashbalance, ttlpointsbalance, adjustmentbalance
           FROM payouttotaltab WHERE uid = ? LIMIT 1`,
        [uid]
      );
      if (ptRows.length) {
        const p = ptRows[0];
        console.log(`\n  [payouttotaltab]`);
        console.log(`    ttlincome1=${p.ttlincome1}  ttlincome2=${p.ttlincome2}  ttlincome3=${p.ttlincome3}`);
        console.log(`    ttlincome4=${p.ttlincome4}  ttlincome41=${p.ttlincome41}  ttlincome5=${p.ttlincome5}  ttlincome51=${p.ttlincome51}  ttlincome6=${p.ttlincome6}`);
        console.log(`    ttlcashbalance=${p.ttlcashbalance}  ttlpointsbalance=${p.ttlpointsbalance}  adjustmentbalance=${p.adjustmentbalance}`);
      } else {
        console.log(`\n  [payouttotaltab]  NO ROW (no income on record)`);
      }
    }
  }
}

// Walk the parent chain via 'refid' or 'drefid' up to maxLevels.
// Detects cycles and missing parent uids.
async function traceChain (pool, startUid, field, maxLevels) {
  if (!startUid || startUid === 0) {
    console.log(`    (none — ${field} is NULL/0)`);
    return;
  }

  const seen = new Set();
  let currentUid = Number(startUid);
  let level = 0;

  while (currentUid && currentUid !== 0 && level < maxLevels) {
    if (seen.has(currentUid)) {
      console.log(`    CYCLE DETECTED at uid=${currentUid} — aborting chain trace`);
      break;
    }
    seen.add(currentUid);

    // eslint-disable-next-line no-await-in-loop
    const [rows] = await pool.query(
      `SELECT u.uid, m.username, u.refid, u.drefid, u.accttype, u.codeid
         FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid
        WHERE u.uid = ? LIMIT 1`,
      [currentUid]
    );

    if (rows.length === 0) {
      console.log(`    L${level + 1}: uid=${currentUid}  [MISSING — not in usertab/memberstab]`);
      break;
    }

    const r = rows[0];
    console.log(`    L${level + 1}: uid=${r.uid}  username=${r.username || 'NULL'}  accttype=${r.accttype}  codeid=${r.codeid}`);

    const nextUid = Number(r[field] || 0);
    if (nextUid === 0 || nextUid === currentUid) break;
    currentUid = nextUid;
    level++;
  }

  if (level >= maxLevels) {
    console.log(`    (chain truncated at ${maxLevels} levels)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
