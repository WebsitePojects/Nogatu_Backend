/**
 * Admin-authorized leadership credit-offset setter — HARD-LOCKED to specific uids.
 *
 * Sets payouttotaltab.leadership_credit_offset = MAX(0, stored ttlincome3 - current engine
 * entitlement) for ONLY the listed accounts, so they resume earning leadership on forward
 * growth without re-crediting already-paid amounts.
 *
 *   newLeadership = MAX(0, engine - ttlincome3 + offset)   (engine change in V037)
 *   At set time   = MAX(0, engine - ttlincome3 + (ttlincome3 - engine)) = 0  -> no instant credit.
 *
 * Set-ONCE: skips any account that already has a non-zero offset (use --force to recompute).
 * Read-only unless --commit. Own transaction. Prints env/DB + every value before any write.
 *
 *   DRY-RUN: NODE_ENV=production node scripts/set_leadership_offset.js
 *   COMMIT : NODE_ENV=production node scripts/set_leadership_offset.js --commit
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const { getLeadershipBonus } = require('../services/income/leadership');

// HARD-LOCKED scope. Do NOT widen without explicit re-authorization.
const UIDS = [5726452, 6122895]; // Lhee143, Elmer143
const COMMIT = process.argv.includes('--commit');
const FORCE = process.argv.includes('--force');

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}  mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}${FORCE ? ' --force' : ''}`);
  console.log(`scope (locked): ${UIDS.join(', ')}\n`);

  for (const uid of UIDS) {
    const [[row]] = await pool.query(
      'SELECT ROUND(ttlincome3,2) led, ROUND(leadership_credit_offset,2) cur_off FROM payouttotaltab WHERE uid=?',
      [uid]
    );
    if (!row) { console.log(`uid ${uid}: NOT FOUND — skipped`); continue; }
    const stored = Number(row.led || 0);
    const curOff = Number(row.cur_off || 0);

    if (curOff > 0 && !FORCE) {
      console.log(`uid ${uid}: already set (offset=${curOff}) — skipping (use --force to recompute)`);
      continue;
    }

    const engine = Number(await getLeadershipBonus(uid));
    const offset = Math.max(0, Number((stored - engine).toFixed(2)));
    console.log(`uid ${uid}: stored=${stored} engine=${engine.toFixed(2)} -> NEW offset=${offset} (was ${curOff})`);

    if (COMMIT) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [res] = await conn.query(
          'UPDATE payouttotaltab SET leadership_credit_offset=? WHERE uid=?',
          [offset, uid]
        );
        await conn.commit();
        console.log(`  -> committed (rows=${res.affectedRows}) offset=${offset} for uid ${uid}`);
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
  }
  if (!COMMIT) console.log('\nDRY-RUN only. Re-run with --commit to apply.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
