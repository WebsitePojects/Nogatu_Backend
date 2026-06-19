/**
 * diagnose_pairing.js  (READ-ONLY)
 *
 * Why a member's pairing shows N in the report/trace but credits M to the wallet.
 * Dumps, side by side: eligibility gate, getPairing engine total + per-day reports,
 * the per-LEG eligible source list with DEPTH (vs the package pairing depth limit),
 * stored ttlincome2, and closure-vs-live coverage. 1 PV = 250 points = PHP 250.
 *
 * Usage: NODE_ENV=staging node scripts/diagnose_pairing.js --username test01
 */
const { loadBackendEnv, getDbConfig } = require('./env');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const pv = (pts) => `${Number(pts || 0)} (${(Number(pts || 0) / 250).toFixed(2)} PV)`;

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${envFile} DB=${db.user}@${db.host}/${db.database}`);

  const username = arg('username');
  if (!username) { console.log('Pass --username <earner>'); return; }

  const { pool } = require('../config/database');
  const { getPairing } = require('../services/income/pairing');
  const { getBinaryPairingEligibility } = require('../services/binaryEligibility');
  const { getEffectiveAccountState, countsForPairingSource } = require('../services/accountState');
  const { getPackagePairingDepthLimit, getPackagePairingWeeklyCap } = require('../services/packagePolicy');

  const [[member]] = await pool.query(
    `SELECT u.uid, u.currentaccttype, u.codeid, u.cdstatus FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid WHERE m.username = ? AND u.uid = u.mainid LIMIT 1`,
    [username]
  );
  if (!member) { console.log(`No member '${username}'`); return; }
  const uid = Number(member.uid);
  const accttype = Number(member.currentaccttype);
  const depthLimit = getPackagePairingDepthLimit(accttype);
  const weeklyCap = getPackagePairingWeeklyCap(accttype);
  console.log(`\nEARNER ${username} uid=${uid} pkg=${accttype} codeid=${member.codeid} cdstatus=${member.cdstatus}`);
  console.log(`package pairing DEPTH LIMIT = ${depthLimit == null ? 'none' : depthLimit}   weeklyCap = ${weeklyCap}`);

  const elig = await getBinaryPairingEligibility(uid);
  console.log(`\n[GATE] canEarnPairing=${elig.canEarnPairing} leftQualifiedDirects=${elig.leftQualifiedCount} rightQualifiedDirects=${elig.rightQualifiedCount}`);

  // ── Per-leg eligible sources with DEPTH (mirror getNumLevels: leg = level-1 ancestor's position) ──
  const legs = { left: [], right: [] };
  async function walk(parentUid, leg, depth) {
    const [rows] = await pool.query(
      `SELECT u.uid, u.position, u.accttype, u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
              u.binarypoints, u.refid, u.drefid, DATE_FORMAT(u.datereg,'%Y-%m-%d') AS datereg, m.username
         FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid WHERE u.refid = ?`,
      [parentUid]
    );
    for (const row of rows) {
      const thisLeg = leg || (Number(row.position) === 1 ? 'left' : 'right');
      const eff = await getEffectiveAccountState(row.uid, row);
      const eligible = eff ? countsForPairingSource(eff) : false;
      const withinDepth = depthLimit == null || depth <= depthLimit;
      legs[thisLeg].push({
        uid: Number(row.uid), username: row.username, depth, bp: Number(row.binarypoints || 0),
        codeid: Number(row.codeid), eligible, withinDepth,
      });
      await walk(row.uid, thisLeg, depth + 1);
    }
  }
  await walk(uid, null, 1);

  for (const side of ['left', 'right']) {
    const all = legs[side];
    const counted = all.filter((n) => n.eligible && n.withinDepth);
    const beyond  = all.filter((n) => n.eligible && !n.withinDepth);
    const sumCounted = counted.reduce((s, n) => s + n.bp, 0);
    const sumBeyond  = beyond.reduce((s, n) => s + n.bp, 0);
    console.log(`\n[${side.toUpperCase()} LEG] eligible+within-depth points = ${pv(sumCounted)}   (eligible but BEYOND depth = ${pv(sumBeyond)})`);
    counted.slice(0, 12).forEach((n) => console.log(`   d${n.depth} ${n.username} bp=${n.bp} codeid=${n.codeid}`));
    if (beyond.length) beyond.slice(0, 12).forEach((n) => console.log(`   d${n.depth} ${n.username} bp=${n.bp}  <<< BEYOND DEPTH ${depthLimit} (engine ignores, trace may show)`));
  }

  // ── Engine ──
  const pr = await getPairing(uid, accttype);
  console.log(`\n[ENGINE] getPairing.totalPay=${pr.totalPay}  leftPts=${pv(pr.leftPts)}  rightPts=${pv(pr.rightPts)}  pairedPts=${pv(pr.pairedPts)}`);
  if (pr.dailyReports && pr.dailyReports.length) {
    console.log('  daily matched (date | leftRpt | rightRpt | matchedPts | cumulative):');
    pr.dailyReports.slice(-14).forEach((d) => console.log(`   ${d.transdate} | L${d.left} | R${d.right} | +${d.totalpoints} | =${d.totalbpay}`));
  }

  const [[tot]] = await pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]);
  console.log(`\n[WALLET] stored ttlincome2 (lifetime pairing) = ${Number(tot?.ttlincome2 || 0)}`);
  console.log(`\nINTERPRET: matchable = min(left eligible+within-depth, right eligible+within-depth).`);
  console.log(`  If a big source shows "BEYOND DEPTH", the trace counts it but the engine cannot (package reach) -> trace over-shows = correct.`);
  console.log(`  If left/right within-depth sums clearly exceed totalPay, the engine UNDER-credits -> real bug, paste this output.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
