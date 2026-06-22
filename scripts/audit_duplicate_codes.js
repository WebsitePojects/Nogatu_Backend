/**
 * READ-ONLY #12 follow-up — duplicate code-string double-benefit check.
 *
 * The lost-codes audit found code STRINGS that appear in codestab more than once (different
 * id, same string). This traces each duplicate for an actual DOUBLE benefit:
 *   - two rows with DIFFERENT producttype (same string used for two package tiers),
 *   - the consuming member registered/upgraded MORE than once off the duplicate,
 *   - >1 upgradetab transtype=1 row for the member (the real money risk: the pairing engine
 *     replays each upgrade row as its own binary event, so a duplicate upgrade = double upstream PV),
 *   - duplicate maintenance (producttype>=100) rows = double repurchase points.
 *
 * Reports only. No writes. Usage:
 *   GREEN: node scripts/audit_duplicate_codes.js
 *   BLUE:  NODE_ENV=production node scripts/audit_duplicate_codes.js
 */
const { loadBackendEnv, getDbConfig } = require('./env');

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_duplicate_codes] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);

  const { pool } = require('../config/database');

  const [dups] = await pool.query(
    `SELECT code, COUNT(*) AS c FROM codestab GROUP BY code HAVING COUNT(*) > 1 ORDER BY c DESC, code`
  );
  if (!dups.length) { console.log('No duplicate code strings. Clean.'); await pool.end().catch(()=>{}); return; }

  console.log(`${dups.length} duplicate code string(s) found.\n`);
  let suspectCount = 0;

  for (const d of dups) {
    const [rows] = await pool.query(
      `SELECT id, producttype, codetype, codestatus, uid,
              DATE_FORMAT(dateused,'%Y-%m-%d %H:%i') AS dateused
         FROM codestab WHERE code = ? ORDER BY id`, [d.code]
    );
    const usedRows = rows.filter((r) => Number(r.codestatus) === 2);
    const distinctPtypes = new Set(rows.map((r) => Number(r.producttype)));
    const distinctUids = [...new Set(usedRows.map((r) => Number(r.uid)).filter(Boolean))];

    const flags = [];
    if (distinctPtypes.size > 1) flags.push(`DIFFERENT producttypes ${[...distinctPtypes].join('/')}`);
    if (usedRows.length > 1) flags.push(`${usedRows.length} rows marked USED`);
    const isMaintenance = [...distinctPtypes].some((p) => p >= 100);
    if (isMaintenance && usedRows.length > 1) flags.push('duplicate MAINTENANCE use = double repurchase points');

    console.log(`code=${d.code}  (${rows.length} rows)`);
    for (const r of rows) {
      console.log(`   id=${r.id} ptype=${r.producttype} ctype=${r.codetype} status=${r.codestatus} uid=${r.uid || '-'} used=${r.dateused || '-'}`);
    }

    for (const uid of distinctUids) {
      const [[u]] = await pool.query(
        `SELECT accttype, currentaccttype, codeid, activationcode,
                DATE_FORMAT(datereg,'%Y-%m-%d') AS datereg FROM usertab WHERE uid = ? LIMIT 1`, [uid]
      );
      const [[upg]] = await pool.query(
        `SELECT COUNT(*) AS n FROM upgradetab WHERE uid = ? AND transtype = 1`, [uid]
      );
      const [[pt]] = await pool.query(
        `SELECT ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome6, ttlcashbalance
           FROM payouttotaltab WHERE uid = ? LIMIT 1`, [uid]
      );
      const usedByThisUid = usedRows.filter((r) => Number(r.uid) === uid).length;
      const activatedOnThis = u && String(u.activationcode) === String(d.code);
      if (usedByThisUid > 1) flags.push(`uid ${uid} consumed the dup ${usedByThisUid}x`);
      if (Number(upg?.n || 0) > 1) flags.push(`uid ${uid} has ${upg.n} upgrade(transtype=1) rows — verify not doubled by this code`);

      console.log(`   -> uid ${uid}: pkg ${u?.accttype}->${u?.currentaccttype} codeid=${u?.codeid} reg=${u?.datereg}` +
        ` activationcode=${u?.activationcode}${activatedOnThis ? ' (==this dup)' : ''}  upgrades(tt1)=${upg?.n}`);
      if (pt) console.log(`      payout: DR=${pt.ttlincome1} pair=${pt.ttlincome2} lead=${pt.ttlincome3} uni=${pt.ttlincome4} h5=${pt.ttlincome5} rank=${pt.ttlincome6} bal=${pt.ttlcashbalance}`);
    }

    if (flags.length) { suspectCount++; console.log(`   ⚠ ${[...new Set(flags)].join(' | ')}`); }
    else console.log('   ✓ no double-benefit signal (single use, same producttype)');
    console.log('');
  }

  console.log(`\nSUMMARY: ${dups.length} duplicate strings, ${suspectCount} with a double-benefit signal to review.`);
  console.log('NOTE: registration benefit is tied to the member\'s ONE usertab row, so a duplicate activation');
  console.log('code rarely doubles an account; the real risk is >1 upgradetab(tt1) row (replayed PV) or a');
  console.log('duplicate maintenance use (double repurchase points). Review the ⚠ rows against those.');
  await pool.end().catch(() => {});
}

main().catch((err) => { console.error('[audit_duplicate_codes] ERROR:', err); process.exit(1); });
