/**
 * Management-authorized correction: mark the 28 legacy activation codes as Used.
 *
 * Background. The legacy PHP registration flow stamped `codestab.dateused` at
 * registration but never advanced `codestab.codestatus` from 1 (Released) to 2 (Used).
 * 28 codes therefore still read as available in production while each had already
 * registered a member back in 2025. One of them, PDEQ8AXFUNN5, was used a second time
 * on 10 August 2026. That one is EXCLUDED here -- it is already status 2 and is being
 * handled separately by management.
 *
 * Authorized by management on 5 September 2026, on the record that in all 28 cases the
 * code is still held by the very member who registered with it, so it has already
 * served its purpose and no member is waiting to use it.
 *
 * HARD-LOCKED to the 28 code ids below. Do NOT widen this list without new sign-off.
 * The ids are pinned rather than re-derived from a predicate, so a future data change
 * cannot silently enlarge the scope of this script.
 *
 * What it writes:   codestab.codestatus 1 -> 2, on those 28 rows, and nothing else.
 * What it preserves: `dateused` is deliberately NOT touched. It still carries the
 *   original 2025 registration timestamp, which is the evidence of the first use. The
 *   current system overwrote exactly that value on PDEQ8AXFUNN5 and destroyed the proof.
 * What it never touches: no member row, no wallet, no income total, no payout history,
 *   no genealogy. Membership status is unchanged for all 28 members.
 *
 * Safety:
 *   - read-only unless --commit
 *   - one transaction, committed only if every row behaves as expected
 *   - each UPDATE re-asserts `codestatus = 1` AND the expected code string AND the
 *     expected owning uid, so a row that drifted since this was authorized is refused
 *     rather than overwritten
 *   - the per-row compare-and-swap IS the guarantee. The money figures printed before
 *     and after are a REPORT taken OUTSIDE the transaction, never a gate: two reads
 *     inside one REPEATABLE READ transaction share one view and would prove nothing.
 *   - re-running is a no-op: already-corrected rows report `already-used` and are skipped
 *
 *   DRY-RUN: NODE_ENV=production node scripts/mark_legacy_used_codes.js
 *   COMMIT : NODE_ENV=production node scripts/mark_legacy_used_codes.js --commit
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');

const COMMIT = process.argv.includes('--commit');

// HARD-LOCKED scope: id, code, and the uid that registered with it. All three must
// still agree in the database or that row is refused. Read from production 4 Sep 2026.
const TARGETS = [
  [105, 'CDBCXSG4QPSW', 1360539], [484, 'PDQBQLIG033L', 2905682],
  [485, 'PDSVZ9ADUFVW', 1263755], [487, 'PDH90LLPJVGI', 6377385],
  [488, 'PDJSJZDNEYYT', 8351493], [489, 'PDVMSN6BZBQE', 5787260],
  [550, 'PDDBXRBIHQJT', 235393], [551, 'PDFVGFU6C3BE', 5470442],
  [552, 'PDROZ3MU6GTP', 2494389], [570, 'PDZXZX9QXYD1', 7098303],
  [758, 'PDBLQM3WFQUN', 691544], [767, 'PDKDM0XPTULY', 8321943],
  [780, 'PDMLKTMQLDIH', 4927695], [851, 'PDEW3ADOC9KS', 6642982],
  [937, 'PDOICM4YK4U8', 6477537], [938, 'PDQBVZXMEHMJ', 7566674],
  [1225, 'PDNUKSI3MEZE', 1498355], [2466, 'PDMG8OIIEKZP', 1709609],
  [2584, 'PDIDPJOE0K6L', 643627], [2665, 'PDXLVI6HAH8M', 6667586],
  [3061, 'PDVX7TECFOUY', 6196429], [3491, 'PDGJROQ3PQFG', 6248041],
  [3492, 'PDT3ACIRK3XR', 7181913], [4760, 'PDYPUGZVR5YP', 8627666],
  [4839, 'PDNXZORYACAQ', 653636], [5030, 'PDQJ1TPE2NUJ', 5396696],
  [5962, 'PDQMXEX7GJTF', 3596299], [5963, 'PD36G2PVBMLQ', 6099982],
];

// Deliberately reads on the POOL, never on the write connection. Two reads inside one
// REPEATABLE READ transaction share a single consistent-read view, so an "after" read
// taken there is structurally incapable of observing anything and proves nothing. These
// run in autocommit, before the transaction opens and after it commits, so each is a
// genuinely fresh read.
async function moneySnapshot() {
  const [[totals]] = await pool.query(
    `SELECT COALESCE(SUM(ttlincome1),0) i1, COALESCE(SUM(ttlincome2),0) i2,
            COALESCE(SUM(ttlincome3),0) i3, COALESCE(SUM(ttlincome4),0) i4,
            COALESCE(SUM(ttlincome5),0) i5, COALESCE(SUM(ttlincome6),0) i6,
            COALESCE(SUM(ttlcashbalance),0) cash
       FROM payouttotaltab`
  );
  const [[hist]] = await pool.query('SELECT COUNT(*) rows_count FROM payouthistorytab');
  const [[members]] = await pool.query(
    'SELECT COUNT(*) members, COALESCE(SUM(status),0) status_sum FROM usertab'
  );
  return { ...totals, ...hist, ...members };
}

function describe(snap) {
  return `i1=${snap.i1} i2=${snap.i2} i3=${snap.i3} i4=${snap.i4} i5=${snap.i5} `
       + `i6=${snap.i6} cash=${snap.cash} history_rows=${snap.rows_count} `
       + `members=${snap.members} status_sum=${snap.status_sum}`;
}

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}  `
            + `mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`scope (locked): ${TARGETS.length} codes\n`);

  const conn = await pool.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();

    const before = await moneySnapshot(conn);
    console.log(`BEFORE  ${describe(before)}\n`);

    const plan = [];
    for (const [id, code, expectedUid] of TARGETS) {
      const [rows] = await conn.query(
        `SELECT c.id, c.code, c.codestatus, c.uid, c.producttype, c.productamount,
                c.dateused,
                (SELECT COUNT(*) FROM usertab u WHERE u.activationcode = c.code) AS members_registered
           FROM codestab c
          WHERE c.id = ?
          FOR UPDATE`,
        [id]
      );

      if (rows.length === 0) { plan.push({ id, code, action: 'MISSING' }); continue; }
      const row = rows[0];

      if (row.code !== code) { plan.push({ id, code, action: `CODE-MISMATCH (${row.code})` }); continue; }
      if (Number(row.codestatus) === 2) { plan.push({ id, code, action: 'already-used, skip' }); continue; }
      if (Number(row.codestatus) !== 1) { plan.push({ id, code, action: `UNEXPECTED-STATUS ${row.codestatus}` }); continue; }
      if (Number(row.uid) !== expectedUid) { plan.push({ id, code, action: `OWNER-DRIFT (${row.uid} not ${expectedUid})` }); continue; }
      if (Number(row.members_registered) < 1) { plan.push({ id, code, action: 'NO-MEMBER, refuse' }); continue; }

      plan.push({
        id, code, action: 'mark used',
        uid: row.uid,
        producttype: row.producttype,
        amount: Number(row.productamount || 0),
        dateused: row.dateused ? String(row.dateused).slice(0, 19) : null,
      });
    }

    const doable = plan.filter((p) => p.action === 'mark used');
    const refused = plan.filter((p) => p.action !== 'mark used' && p.action !== 'already-used, skip');
    const skipped = plan.filter((p) => p.action === 'already-used, skip');

    for (const p of plan) {
      console.log(`  id=${String(p.id).padStart(4)} ${p.code}  ${p.action}`
                + (p.uid ? `  uid=${p.uid} ptype=${p.producttype} used=${p.dateused}` : ''));
    }
    console.log(`\n  to mark: ${doable.length}   already used: ${skipped.length}   refused: ${refused.length}`);
    console.log(`  package value covered: PHP ${doable.reduce((s, p) => s + p.amount, 0).toLocaleString()}\n`);

    if (refused.length > 0) {
      throw new Error(`${refused.length} row(s) did not match the authorized state. `
                    + 'Nothing was written. Re-verify before running again.');
    }

    if (!COMMIT) {
      await conn.rollback();
      console.log('DRY-RUN: rolled back, nothing written. Re-run with --commit to apply.');
      return;
    }

    let updated = 0;
    for (const p of doable) {
      // Compare-and-swap. dateused is deliberately left alone: it holds the original
      // 2025 registration timestamp, which is the evidence of the first use.
      const [res] = await conn.query(
        'UPDATE codestab SET codestatus = 2 WHERE id = ? AND code = ? AND uid = ? AND codestatus = 1',
        [p.id, p.code, p.uid]
      );
      if (Number(res.affectedRows) !== 1) {
        throw new Error(`CAS failed on id=${p.id} ${p.code}: affectedRows=${res.affectedRows}. `
                      + 'Rolling back the whole batch.');
      }
      updated += 1;
    }

    await conn.commit();
    committed = true;
    console.log(`COMMITTED: ${updated} code(s) marked Used.`);
    // Post-commit verification. Every write this script makes is a codestatus flip on
    // codestab, each one a compare-and-swap that already asserted affectedRows === 1 --
    // that CAS is the real guarantee, not the figures below. This is a REPORT: on a live
    // system other traffic commits during the run, so a difference here means concurrent
    // member activity, not damage by this script. Investigate a difference; do not assume
    // one cannot appear.
    const after = await moneySnapshot();
    console.log(`AFTER   ${describe(after)}`);
    const drift = Object.keys(before).filter((k) => String(before[k]) !== String(after[k]));
    console.log(drift.length === 0
      ? 'money + membership unchanged across the run'
      : `NOTE: concurrent activity moved ${drift.join(', ')} during the run -- `
        + 'this script writes only codestab.codestatus, so verify the cause before assuming it is related.');

    const [[check]] = await pool.query(
      `SELECT COUNT(*) still_released FROM codestab
        WHERE id IN (${TARGETS.map(() => '?').join(',')}) AND codestatus <> 2`,
      TARGETS.map(([id]) => id)
    );
    console.log(`verification: ${check.still_released} of ${TARGETS.length} target rows are NOT status 2 `
              + `(expected 0)`);
  } catch (err) {
    if (!committed) await conn.rollback().catch(() => {});
    // `committed` decides the wording. Once the commit lands the 28 rows ARE changed,
    // and a later failure in the verification read must not report 'nothing committed' --
    // that would send an operator to re-run a job that already succeeded.
    console.error(committed
      ? `
COMMIT SUCCEEDED, but a post-commit step failed: ${err.message}
`
        + '  The codes ARE marked Used. Verify with the read-only query; do not re-run blindly.'
      : `
FAILED, nothing committed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
