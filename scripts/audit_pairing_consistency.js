/**
 * READ-ONLY — pairing wallet-vs-trace consistency check for ONE member.
 *
 * Pinpoints the t01left-type discrepancy: the pairing TRACE (income_eventstab / pairing
 * ledger) can show "Credited" matched events while the authoritative WALLET total
 * (payouttotaltab.ttlincome2) is 0 — because the tracker computes creditedIncome per match
 * without locking on OWNER eligibility, whereas the wallet credit path can gate it.
 *
 * For the given member it prints:
 *   - usertab (codeid/refid/position/binarypoints) + the binary children (left/right) with codeid,
 *   - personally-sponsored directs (drefid = uid) and how many are PD / fully-paid CD (qualified),
 *   - WALLET authoritative pairing total: payouttotaltab.ttlincome2  ← the truth,
 *   - TRACE credited total: SUM(income_eventstab.gross_amount) for pairing_bonus credited,
 *   - getBinaryPairingEligibility(uid) (whether the engine lets the OWNER receive pairing),
 *   - the DISAGREEMENT (wallet vs trace) = the finding.
 *
 * Usage:  GREEN: node scripts/audit_pairing_consistency.js <username|uid>
 *         BLUE:  NODE_ENV=production node scripts/audit_pairing_consistency.js <username|uid>
 * READ-ONLY. No writes.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

async function main() {
  const target = process.argv[2];
  if (!target) { console.error('Usage: node scripts/audit_pairing_consistency.js <username|uid>'); process.exit(1); }

  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_pairing_consistency] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);

  const { pool } = require('../config/database');
  const { getEffectiveAccountState, countsForPairingSource } = require('../services/accountState');

  const uid = /^\d+$/.test(target)
    ? Number(target)
    : Number((await pool.query('SELECT uid FROM memberstab WHERE username=? LIMIT 1', [target]))[0][0]?.uid || 0);
  if (!uid) { console.log(`${target}: not found`); await pool.end().catch(()=>{}); return; }

  const [[u]] = await pool.query(
    `SELECT u.uid, m.username, u.codeid, u.cdstatus, u.accttype, u.currentaccttype,
            u.refid, u.position, u.binarypoints
       FROM usertab u LEFT JOIN memberstab m ON m.uid=u.uid WHERE u.uid=? LIMIT 1`, [uid]);
  console.log(`MEMBER ${u.username} (uid ${uid}) codeid=${u.codeid} acct=${u.accttype}->${u.currentaccttype} refid=${u.refid} pos=${u.position} bp=${u.binarypoints}\n`);

  // Binary children (legs) — who is placed directly under this member's refid.
  const [kids] = await pool.query(
    `SELECT u.uid, m.username, u.codeid, u.cdstatus, u.position, u.binarypoints, u.drefid
       FROM usertab u LEFT JOIN memberstab m ON m.uid=u.uid
      WHERE u.refid=? AND u.uid<>u.refid ORDER BY u.position`, [uid]);
  console.log('BINARY CHILDREN (legs):');
  for (const k of kids) {
    const eff = await getEffectiveAccountState(k.uid, k).catch(()=>k);
    const isSrc = countsForPairingSource(eff);
    const sponsoredByOwner = Number(k.drefid) === uid;
    console.log(`  ${k.position === 1 ? 'L' : 'R'} ${k.username} (uid ${k.uid}) codeid=${k.codeid} bp=${k.binarypoints} ` +
      `pairingSource=${isSrc} sponsoredBy=${k.drefid}${sponsoredByOwner ? ' (THIS member)' : ' (spillover/other)'}`);
  }

  // Personally-sponsored directs (drefid = uid) — the "qualified directs" concept.
  const [directs] = await pool.query(
    `SELECT u.uid, u.codeid, u.cdstatus FROM usertab u WHERE u.drefid=? AND u.uid<>u.drefid`, [uid]);
  let qualifiedDirects = 0;
  for (const d of directs) {
    const eff = await getEffectiveAccountState(d.uid, d).catch(()=>d);
    if (countsForPairingSource(eff)) qualifiedDirects += 1;
  }
  console.log(`\nPERSONALLY-SPONSORED directs (drefid=${uid}): ${directs.length} total, ${qualifiedDirects} PD/paid-CD qualified`);

  // WALLET authoritative pairing total.
  const [[pt]] = await pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid=? LIMIT 1', [uid]);
  const walletPairing = Number(pt?.ttlincome2 || 0);

  // TRACE credited total from income_eventstab (pairing).
  let traceCredited = null;
  try {
    const [[ev]] = await pool.query(
      `SELECT COALESCE(SUM(gross_amount),0) AS s, COUNT(*) AS c
         FROM income_eventstab
        WHERE beneficiary_uid=? AND income_type='pairing_bonus' AND status='credited'`, [uid]);
    traceCredited = { sum: Number(ev.s || 0), count: Number(ev.c || 0) };
  } catch (e) { traceCredited = { err: e.code || e.message }; }

  // Owner eligibility per the engine.
  let ownerEligible = null;
  try {
    const { getBinaryPairingEligibility } = require('../services/income/pairingTracker');
    if (typeof getBinaryPairingEligibility === 'function') {
      ownerEligible = await getBinaryPairingEligibility(uid).catch((e) => ({ err: e.message }));
    }
  } catch (_) { /* not exported — skip */ }

  console.log('\n================ CONSISTENCY ================');
  console.log(`WALLET ttlincome2 (authoritative, already-paid): PHP ${walletPairing.toLocaleString()}`);
  console.log(`TRACE  income_eventstab credited pairing:        ${traceCredited.err ? 'ERR '+traceCredited.err : `PHP ${traceCredited.sum.toLocaleString()} across ${traceCredited.count} event(s)`}`);
  if (ownerEligible != null) console.log(`OWNER pairing eligibility (engine): ${JSON.stringify(ownerEligible)}`);
  if (!traceCredited.err) {
    const diff = traceCredited.sum - walletPairing;
    if (Math.abs(diff) >= 1) {
      console.log(`\n⚠ DISAGREEMENT: trace shows PHP ${traceCredited.sum.toLocaleString()} credited but wallet ttlincome2 = PHP ${walletPairing.toLocaleString()} (Δ ${diff}).`);
      console.log('   The WALLET is authoritative. If the wallet is 0 by an owner-eligibility gate, the trace is');
      console.log('   mislabeling a blocked match as "Credited" — the trace/ledger must reflect the gate (creditedIncome=0).');
    } else {
      console.log('\n✓ wallet and trace agree.');
    }
  }
  console.log('\nDone (read-only).');
  await pool.end().catch(()=>{});
}

main().catch((err) => { console.error('[audit_pairing_consistency] ERROR:', err); process.exit(1); });
