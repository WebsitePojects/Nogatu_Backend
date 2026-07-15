/**
 * READ-ONLY deep inspection of a member's activation codes on the live DB.
 * Performs NO writes. Prints, for every code tied to the member, its COMPLETE
 * event chain (every hop, not just the member's own actions) so a holder that
 * differs from who the member "sent to" is fully explained, plus integrity
 * flags for the code system.
 *
 * Usage (BLUE / production):
 *   cd /var/www/nogatu
 *   NODE_ENV=production node scripts/inspect_member_codes.js --username tabsqui
 *   NODE_ENV=production node scripts/inspect_member_codes.js --username tabsqui --code PDGOIVTDQW5Z
 *   NODE_ENV=production node scripts/inspect_member_codes.js --system   # system-wide integrity only
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const { PRODUCT_TYPES } = require('../utils/helpers');

const STATUS = { 0: 'Not Released', 1: 'Released', 2: 'Used' };

function parseArgs(argv) {
  const o = { username: null, code: null, system: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--username' || a === '-u') && argv[i + 1]) o.username = argv[++i];
    else if (a === '--code' && argv[i + 1]) o.code = argv[++i];
    else if (a === '--system') o.system = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function tableExists(conn, name) {
  const [r] = await conn.query('SHOW TABLES LIKE ?', [name]);
  return r.length > 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.username && !opts.system)) {
    console.log('Usage: NODE_ENV=production node scripts/inspect_member_codes.js --username <name> [--code <ACTIVATION>] | --system');
    return;
  }

  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${process.env.NODE_ENV || 'unset'} (${envFile}) DB=${db.user}@${db.host}/${db.database}`);
  console.log('MODE: READ-ONLY (no writes)');
  console.log('='.repeat(70));

  const conn = await mysql.createConnection(db);
  try {
    const hasUsage = await tableExists(conn, 'activation_code_usagetab');

    // ---- System-wide integrity (always cheap, always print) ----------------
    console.log('SYSTEM INTEGRITY');
    const [[codeTotals]] = await conn.query(
      `SELECT COUNT(*) total,
              SUM(codestatus=0) not_released,
              SUM(codestatus=1) released,
              SUM(codestatus=2) used,
              MIN(dategen) earliest, MAX(dategen) latest
       FROM codestab`
    );
    console.log(`  codestab: ${codeTotals.total} total | not_released ${codeTotals.not_released} | released ${codeTotals.released} | used ${codeTotals.used}`);
    console.log(`  generated span: ${codeTotals.earliest} .. ${codeTotals.latest}`);
    const [[dupCodes]] = await conn.query(
      `SELECT COUNT(*) dup_values FROM (SELECT code FROM codestab GROUP BY code HAVING COUNT(*) > 1) x`
    );
    console.log(`  duplicate code values: ${dupCodes.dup_values}`);
    const [[orphanHolder]] = await conn.query(
      `SELECT COUNT(*) n FROM codestab c LEFT JOIN memberstab m ON m.uid=c.uid WHERE c.uid IS NOT NULL AND c.uid<>0 AND m.uid IS NULL`
    );
    console.log(`  codes whose holder uid has no member row: ${orphanHolder.n}`);
    if (hasUsage) {
      const [[usageTotals]] = await conn.query(
        `SELECT COUNT(*) events, COUNT(DISTINCT code) codes FROM activation_code_usagetab`
      );
      console.log(`  activation_code_usagetab: ${usageTotals.events} events across ${usageTotals.codes} codes`);
    } else {
      console.log('  activation_code_usagetab: (table not present)');
    }
    console.log('='.repeat(70));

    if (opts.system && !opts.username) return;

    // ---- Member resolution -------------------------------------------------
    const [members] = await conn.query(
      `SELECT uid, username, TRIM(CONCAT(COALESCE(firstname,''),' ',COALESCE(lastname,''))) fullname
       FROM memberstab WHERE username = ? OR TRIM(username) = ?`,
      [opts.username, opts.username]
    );
    if (members.length !== 1) {
      console.log(`Member "${opts.username}": ${members.length} matches — cannot inspect a single member.`);
      members.forEach((m) => console.log(`  uid=${m.uid} username="${m.username}"`));
      return;
    }
    const me = members[0];
    console.log(`MEMBER: uid=${me.uid} username="${me.username}" name="${me.fullname}"`);

    // ---- The member's complete code set ------------------------------------
    const setParams = [me.uid, me.username];
    let setSql = '(c.uid = ? OR c.processid = ?';
    if (hasUsage) {
      setSql += ` OR c.code IN (SELECT code FROM activation_code_usagetab
        WHERE from_uid=? OR to_uid=? OR actor_uid=? OR registration_uid=? OR upgrade_uid=?)`;
      setParams.push(me.uid, me.uid, me.uid, me.uid, me.uid);
    }
    setSql += ')';
    if (opts.code) { setSql += ' AND c.code = ?'; setParams.push(opts.code); }

    const [codes] = await conn.query(
      `SELECT c.id, c.code, c.producttype, c.codestatus, c.processid, c.uid,
              DATE_FORMAT(c.dategen,'%Y-%m-%d %H:%i') dategen,
              hm.username holder_username
       FROM codestab c LEFT JOIN memberstab hm ON hm.uid=c.uid
       WHERE ${setSql}
       ORDER BY c.codestatus DESC, c.dategen DESC, c.id DESC`,
      setParams
    );
    console.log(`CODES TIED TO MEMBER: ${codes.length}`);

    // Pull full event chains for the non-trivial (transferred/used) codes so
    // the output stays readable; held+unused codes are summarized in bulk.
    const focusCodes = codes.filter((c) => c.codestatus === 2 || c.uid !== me.uid).map((c) => c.code);
    let chains = new Map();
    if (hasUsage && focusCodes.length) {
      const ph = focusCodes.map(() => '?').join(',');
      const [events] = await conn.query(
        `SELECT a.code, a.event_type,
                DATE_FORMAT(a.created_at,'%Y-%m-%d %H:%i') at,
                fm.username from_u, tm.username to_u, am.username actor_u, rm.username reg_u
         FROM activation_code_usagetab a
         LEFT JOIN memberstab fm ON fm.uid=a.from_uid
         LEFT JOIN memberstab tm ON tm.uid=a.to_uid
         LEFT JOIN memberstab am ON am.uid=a.actor_uid
         LEFT JOIN memberstab rm ON rm.uid=COALESCE(a.registration_uid,a.upgrade_uid)
         WHERE a.code IN (${ph})
         ORDER BY a.code, a.id`,
        focusCodes
      );
      for (const e of events) {
        if (!chains.has(e.code)) chains.set(e.code, []);
        chains.get(e.code).push(e);
      }
    }

    console.log('-'.repeat(70));
    console.log('FOCUS CODES (transferred out or used) — full journey:');
    let mismatches = 0;
    for (const c of codes.filter((c) => c.codestatus === 2 || c.uid !== me.uid)) {
      const pkg = PRODUCT_TYPES[c.producttype] || `Type ${c.producttype}`;
      console.log(`\n  ${c.code} | ${pkg} | status=${STATUS[c.codestatus]} | holder_now=${c.holder_username || '(uid ' + c.uid + ')'} | gen=${c.dategen}`);
      const chain = chains.get(c.code) || [];
      if (!chain.length) { console.log('     (no usage events recorded)'); continue; }
      for (const e of chain) {
        const parties = e.event_type === 'registration_use'
          ? `registrant=${e.reg_u || '(unknown)'}`
          : `${e.from_u || e.actor_u || '?'} -> ${e.to_u || '?'}`;
        console.log(`     ${e.at}  ${String(e.event_type).padEnd(16)} ${parties}`);
      }
      // Integrity: does the last transfer's to-party equal the current holder?
      const lastTransfer = [...chain].reverse().find((e) => e.to_u);
      if (lastTransfer && c.holder_username && lastTransfer.to_u !== c.holder_username && c.codestatus !== 2) {
        console.log(`     ⚠ holder_now (${c.holder_username}) != last transfer to (${lastTransfer.to_u})`);
        mismatches += 1;
      }
    }

    console.log('\n' + '-'.repeat(70));
    const held = codes.filter((c) => c.uid === me.uid && c.codestatus !== 2).length;
    const heldUsed = codes.filter((c) => c.uid === me.uid && c.codestatus === 2).length;
    const movedOut = codes.filter((c) => c.uid !== me.uid).length;
    console.log(`SUMMARY: total ${codes.length} | held(unused) ${held} | held(used) ${heldUsed} | left her account ${movedOut}`);
    console.log(`Integrity flags: holder<>last-transfer mismatches = ${mismatches}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[inspect_member_codes] FATAL:', err.message);
  process.exitCode = 1;
});
