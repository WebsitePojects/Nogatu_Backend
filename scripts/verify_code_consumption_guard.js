/**
 * READ-ONLY verification of the activation-code consumption guard.
 *
 * Runs the real guard (services/codeConsumption.js) against a real database, with no
 * HTTP layer -- which matters here, because session cookies are Secure and plain-HTTP
 * API testing on this box cannot authenticate at all (see .claude/rules/blue-green.md).
 *
 * Issues SELECTs only. It opens no transaction, takes no locks, and calls one function
 * that itself only reads. There is no INSERT, UPDATE or DELETE in this file.
 *
 * Works against either database and adapts its expectations:
 *   green/staging:  node scripts/verify_code_consumption_guard.js
 *   blue/prod:      NODE_ENV=production node scripts/verify_code_consumption_guard.js
 *
 * Background. Legacy PHP stamped `codestab.dateused` at registration but never advanced
 * `codestab.codestatus`, leaving 28 production codes readable as available while each had
 * already registered a member in 2025. One was reused in August 2026. Those 28 were
 * corrected on 5 September 2026, so on production this script should now find ZERO codes
 * of that shape -- an empty result here is the healthy outcome, not a broken test.
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const { assertCodeNotAlreadyConsumed, findMemberRegistrationEvidence } =
  require('../services/codeConsumption');
const { checkCode, validateCode } = require('../services/registration');

// The codes corrected on 5 September 2026. Pinned so this script can confirm they
// stayed corrected, independently of any predicate that might drift.
const CORRECTED = [
  105, 484, 485, 487, 488, 489, 550, 551, 552, 570, 758, 767, 780, 851, 937, 938,
  1225, 2466, 2584, 2665, 3061, 3491, 3492, 4760, 4839, 5030, 5962, 5963,
];

const AVAILABLE_SAMPLE_SIZE = 300;

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
};

async function refusalFor(code, row) {
  try {
    await assertCodeNotAlreadyConsumed(pool, code, row);
    return null;
  } catch (err) {
    if (err.code !== 'CODE_ALREADY_USED') throw err;
    return err.details;
  }
}

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  const isProd = who.d === 'nogatualliance_sysdb';
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d} `
            + `(${isProd ? 'PRODUCTION' : 'staging'})  READ-ONLY\n`);

  const [shape] = await pool.query(
    `SELECT codestatus, COUNT(*) codes, SUM(dateused IS NOT NULL) with_dateused
       FROM codestab GROUP BY codestatus ORDER BY codestatus`
  );
  console.log('code population:');
  for (const r of shape) {
    console.log(`  status=${r.codestatus}  codes=${r.codes}  with_dateused=${r.with_dateused}`);
  }
  console.log('');

  // ---- 1. anything still carrying the exposed shape must be refused
  console.log('1. released codes that already carry a used-date must be REFUSED');
  const [exposed] = await pool.query(
    'SELECT * FROM codestab WHERE codestatus = 1 AND dateused IS NOT NULL ORDER BY id'
  );
  if (exposed.length === 0) {
    console.log('  none present -- on production this is the corrected, healthy state');
  } else {
    let refused = 0;
    for (const row of exposed) {
      if (await refusalFor(row.code, row)) refused += 1;
      else console.log(`  FAIL  ${row.code} (id ${row.id}) was NOT refused`);
    }
    check(refused === exposed.length, `refused ${refused} of ${exposed.length}`);
  }
  console.log('');

  // ---- 2. genuinely available codes must all be allowed (a false refusal blocks a sale)
  console.log(`2. up to ${AVAILABLE_SAMPLE_SIZE} genuinely available codes must be ALLOWED`);
  const [free] = await pool.query(
    `SELECT c.* FROM codestab c
      WHERE c.codestatus = 1 AND c.dateused IS NULL
        AND NOT EXISTS (SELECT 1 FROM usertab u WHERE u.activationcode = c.code)
      ORDER BY c.id DESC LIMIT ${AVAILABLE_SAMPLE_SIZE}`
  );
  let wronglyRefused = 0;
  for (const row of free) {
    const d = await refusalFor(row.code, row);
    if (d) {
      wronglyRefused += 1;
      if (wronglyRefused <= 5) console.log(`  FAIL  ${row.code} wrongly refused (${d.evidence})`);
    }
  }
  check(wronglyRefused === 0, `allowed ${free.length - wronglyRefused} of ${free.length}`);
  console.log('');

  // ---- 3. member-side evidence alone must still refuse, with dateused ignored
  console.log('3. member-side evidence alone must REFUSE (used-date ignored)');
  const [[linked]] = await pool.query(
    `SELECT c.* FROM codestab c JOIN usertab u ON u.activationcode = c.code
      ORDER BY c.id LIMIT 1`
  );
  if (!linked) {
    console.log('  SKIP  no member-linked code found');
  } else {
    const d = await refusalFor(linked.code, { ...linked, dateused: null });
    check(Boolean(d), `${linked.code} refused on the member link alone`
                    + (d ? ` (uid ${d.registeredUid})` : ''));
  }
  console.log('');

  // ---- 4. duplicate strings: a free twin must never be refused
  console.log('4. duplicate code strings -- a free twin must NOT be refused');
  const [dups] = await pool.query(
    `SELECT code, COUNT(*) rows_count, SUM(codestatus = 1) available
       FROM codestab GROUP BY code HAVING rows_count > 1 ORDER BY code`
  );
  console.log(`  duplicate strings: ${dups.length}`);
  for (const d of dups) {
    const ev = await findMemberRegistrationEvidence(pool, d.code);
    const refusesNow = ev.membersRegistered > 0 && ev.membersRegistered >= ev.physicalRows;
    console.log(`   ${d.code}  rows=${d.rows_count} available=${d.available} `
              + `members=${ev.membersRegistered}  verdict=${refusesNow ? 'REFUSE' : 'allow'}`);
    if (Number(d.available) > 0 && ev.membersRegistered < ev.physicalRows) {
      check(!refusesNow, `${d.code} has a free twin and must not be refused`);
    }
  }
  console.log('');

  // ---- 5. the read paths must agree with the gate
  console.log('5. read-only checks must not advertise a consumed code');
  const [[consumed]] = await pool.query(
    'SELECT code FROM codestab WHERE codestatus = 2 AND dateused IS NOT NULL ORDER BY id LIMIT 1'
  );
  if (!consumed) {
    console.log('  SKIP  no consumed code found');
  } else {
    check(await checkCode(consumed.code) === null, `checkCode rejects ${consumed.code}`);
    check(await validateCode(consumed.code) === false, `validateCode rejects ${consumed.code}`);
  }
  console.log('');

  // ---- 6. the corrected codes must have stayed corrected, with their evidence intact
  console.log('6. the 28 corrected codes must still be Used, with 2025 dates preserved');
  const [[corrected]] = await pool.query(
    `SELECT COUNT(*) total, SUM(codestatus = 2) used, SUM(dateused IS NOT NULL) with_dateused,
            MIN(dateused) earliest, MAX(dateused) latest
       FROM codestab WHERE id IN (${CORRECTED.map(() => '?').join(',')})`,
    CORRECTED
  );
  if (Number(corrected.total) === 0) {
    console.log('  SKIP  this database does not contain the corrected rows');
  } else {
    check(Number(corrected.used) === Number(corrected.total),
      `${corrected.used} of ${corrected.total} are status 2`);
    check(Number(corrected.with_dateused) === Number(corrected.total),
      `${corrected.with_dateused} of ${corrected.total} retain their original used-date`);
    console.log(`  original evidence preserved: ${corrected.earliest} .. ${corrected.latest}`);
  }
  console.log('');

  console.log(failures === 0
    ? 'RESULT: guard verified, no write issued'
    : `RESULT: ${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
  await pool.end();
})().catch(async (err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
