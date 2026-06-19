/**
 * diagnose_pairing.js  (READ-ONLY)
 *
 * Explains why a member's pairing shows in the report/trace but does not credit the
 * wallet. For a username it prints, side by side:
 *   - effective account state
 *   - getBinaryPairingEligibility (canEarnPairing + qualified directs per leg)  <- the CREDIT gate
 *   - getPairing totalPay / left / right points                                <- what would credit
 *   - stored ttlincome2 (already-credited lifetime pairing)
 *   - binary_tree_closuretab coverage for this owner (the gate's data source)
 *
 * If canEarnPairing is FALSE but matches exist, the gate is the blocker. If the
 * closure has fewer descendants than the live refid subtree, the closure is stale
 * (rebuild it). No writes. Prints env=/DB= first.
 *
 * Usage: NODE_ENV=staging node scripts/diagnose_pairing.js --username t01rightsub
 *        (use the EARNER's username — the account whose wallet should receive pairing)
 */
const { loadBackendEnv, getDbConfig } = require('./env');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${envFile} DB=${db.user}@${db.host}/${db.database}`);

  const username = arg('username');
  if (!username) { console.log('Pass --username <earner>'); return; }

  const { pool } = require('../config/database');
  const { getPairing } = require('../services/income/pairing');
  const { getBinaryPairingEligibility } = require('../services/binaryEligibility');
  const { getEffectiveAccountState } = require('../services/accountState');

  const [[member]] = await pool.query(
    `SELECT u.uid, u.currentaccttype, u.codeid, u.cdstatus, u.refid, u.drefid, u.position
       FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid
      WHERE m.username = ? AND u.uid = u.mainid LIMIT 1`,
    [username]
  );
  if (!member) { console.log(`No member '${username}'`); return; }
  const uid = Number(member.uid);
  console.log(`\nEARNER ${username} uid=${uid} pkg=${member.currentaccttype} codeid=${member.codeid} cdstatus=${member.cdstatus}`);

  const eff = await getEffectiveAccountState(uid);
  console.log(`effectiveState: codeid=${eff?.codeid} cdstatus=${eff?.cdstatus} currentaccttype=${eff?.currentaccttype}`);

  // The CREDIT gate
  const elig = await getBinaryPairingEligibility(uid);
  console.log(`\n[CREDIT GATE] canEarnPairing=${elig.canEarnPairing}  leftQualified=${elig.leftQualifiedCount}  rightQualified=${elig.rightQualifiedCount}`);
  console.log(`  qualifiedDirects.left : ${elig.qualifyingDirects.left.map((d) => `${d.username}(${d.accountState})`).join(', ') || '(none)'}`);
  console.log(`  qualifiedDirects.right: ${elig.qualifyingDirects.right.map((d) => `${d.username}(${d.accountState})`).join(', ') || '(none)'}`);
  if (!elig.canEarnPairing) console.log(`  reason: ${elig.reason}`);

  // What WOULD credit
  const pr = await getPairing(uid, Number(member.currentaccttype));
  console.log(`\n[ENGINE] getPairing.totalPay=${pr.totalPay}  leftPts=${pr.leftPts}  rightPts=${pr.rightPts}  pairedPts=${pr.pairedPts}`);

  const [[tot]] = await pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]);
  console.log(`[WALLET] stored ttlincome2 (lifetime pairing) = ${Number(tot?.ttlincome2 || 0)}`);

  // Closure coverage vs live refid subtree
  const [[clo]] = await pool.query(
    `SELECT COUNT(*) AS n FROM binary_tree_closuretab WHERE ancestor_uid = ? AND depth > 0 AND leg IN ('left','right')`,
    [uid]
  );
  const [[live]] = await pool.query(
    `WITH RECURSIVE t AS (
       SELECT uid FROM usertab WHERE refid = ?
       UNION ALL SELECT u.uid FROM usertab u INNER JOIN t ON u.refid = t.uid
     ) SELECT COUNT(*) AS n FROM t`,
    [uid]
  );
  console.log(`\n[CLOSURE] binary descendants in closure=${clo.n}  vs live refid subtree=${live.n}  ${clo.n < live.n ? '<<< STALE CLOSURE (rebuild)' : 'ok'}`);

  console.log(`\nVERDICT: ${
    elig.canEarnPairing
      ? (pr.totalPay > Number(tot?.ttlincome2 || 0)
          ? 'gate OPEN + engine has new pairing -> SHOULD credit on next dashboard/ewallet load.'
          : 'gate OPEN but totalPay <= stored ttlincome2 -> already credited (no NEW pairing).')
      : (pr.leftPts > 0 && pr.rightPts > 0
          ? 'gate CLOSED while matches exist -> BLOCKED. If closure is stale, rebuild; else owner has no QUALIFIED DIRECT (spillover-only does not unlock pairing).'
          : 'gate CLOSED + no matched points on a leg yet.')
  }`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
