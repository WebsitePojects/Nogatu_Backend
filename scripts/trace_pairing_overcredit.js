/**
 * READ-ONLY per-account trace: which INELIGIBLE source accounts (FS / unpaid-CD)
 * inflated this member's matched pairing beyond the eligible weak leg.
 *
 * Shows, side by side:
 *   - ELIGIBLE legs  = PD + fully-paid CD only (what the correct engine counts)
 *   - ALL legs       = including FS / unpaid-CD (what the old bug counted)
 *   - stored SMB (ttlincome2)
 * then lists every ineligible source node per leg with its binary points + reg date.
 * The ineligible points on the WEAK leg are the direct cause of the excess matched.
 *
 * Usage:  NODE_ENV=production node scripts/trace_pairing_overcredit.js <username|uid>
 * Read-only. No writes.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const CODE = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const target = process.argv[2];
  if (!target) { console.log('Usage: node scripts/trace_pairing_overcredit.js <username|uid>'); process.exit(1); }
  console.log(`\n[trace_pairing_overcredit] READ-ONLY · env=${envFile} db=${cfg.database}@${cfg.host} target=${target}\n`);

  const { pool } = require('../config/database');
  const { getEffectiveAccountState, countsForPairingSource } = require('../services/accountState');
  const { getPairing } = require('../services/income/pairing');

  const [meRows] = await pool.query(
    `SELECT u.uid, u.currentaccttype, m.username, COALESCE(p.ttlincome2,0) AS smb
       FROM usertab u JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN payouttotaltab p ON p.uid = u.uid
      WHERE m.username = ? OR u.uid = ? LIMIT 1`,
    [String(target), Number(target) || 0]
  );
  if (!meRows.length) { console.log('Account not found.'); await pool.end(); return; }
  const me = meRows[0];
  const stored = Number(me.smb || 0);

  // Eligible baseline straight from the live engine (it already excludes ineligible).
  const res = await getPairing(Number(me.uid), Number(me.currentaccttype || 0));
  const eligL = Number(res.leftPts || 0);
  const eligR = Number(res.rightPts || 0);
  const pairedEligible = Math.min(eligL, eligR);

  // Full traversal: every node with binary points, per overall leg (level-1 side).
  const all = [];
  async function walk(parentUid, depth, leg) {
    const [rows] = await pool.query(
      `SELECT uid, position, codeid, accttype, currentaccttype, cdamount, cdtotal, cdstatus, binarypoints,
              DATE_FORMAT(datereg,'%Y-%m-%d') AS datereg
         FROM usertab WHERE refid = ?`,
      [parentUid]
    );
    for (const base of rows) {
      // eslint-disable-next-line no-await-in-loop
      const row = (await getEffectiveAccountState(base.uid, base)) || base;
      const nodeLeg = depth === 1 ? (Number(base.position) === 1 ? 'left' : 'right') : leg;
      all.push({
        uid: base.uid,
        leg: nodeLeg,
        depth,
        codeid: Number(row.codeid != null ? row.codeid : base.codeid) || 0,
        cdstatus: Number(row.cdstatus != null ? row.cdstatus : base.cdstatus) || 0,
        bp: Number(row.binarypoints != null ? row.binarypoints : base.binarypoints) || 0,
        eligible: countsForPairingSource(row),
        datereg: base.datereg,
      });
      // eslint-disable-next-line no-await-in-loop
      await walk(base.uid, depth + 1, nodeLeg);
    }
  }
  await walk(me.uid, 1, null);

  const sumBp = (pred) => all.filter(pred).reduce((s, n) => s + n.bp, 0);
  const allLeft = sumBp((n) => n.leg === 'left');
  const allRight = sumBp((n) => n.leg === 'right');
  const pairedAll = Math.min(allLeft, allRight);
  const pv = (x) => (x / 250).toFixed(2);

  console.log(`ROOT uid=${me.uid} @${me.username} acct=${me.currentaccttype}`);
  console.log(`stored SMB (ttlincome2) = ${stored}  (= ${pv(stored)} PV)\n`);
  console.log(`ELIGIBLE legs (PD + fully-paid CD):  L=${eligL}  R=${eligR}  -> matched = ${pairedEligible}  (= ${pv(pairedEligible)} PV)`);
  console.log(`ALL legs (incl FS / unpaid-CD):      L=${allLeft}  R=${allRight}  -> matched = ${pairedAll}  (= ${pv(pairedAll)} PV)\n`);
  console.log(`OVER-CREDIT vs eligible ceiling = ${stored - pairedEligible}  (= ${pv(stored - pairedEligible)} PV)`);
  console.log(`(if the old bug counted ALL sources, matched would be ~${pairedAll} — compare to stored ${stored})\n`);

  const ineligible = all.filter((n) => !n.eligible && n.bp > 0)
    .sort((a, b) => (a.leg === b.leg ? b.bp - a.bp : a.leg.localeCompare(b.leg)));

  // Batch-resolve usernames for the ones we print.
  const showUids = [...new Set(ineligible.slice(0, 80).map((n) => n.uid))];
  let nameMap = {};
  if (showUids.length) {
    const [mr] = await pool.query(
      `SELECT uid, username FROM memberstab WHERE uid IN (${showUids.map(() => '?').join(',')})`, showUids);
    nameMap = Object.fromEntries(mr.map((m) => [Number(m.uid), m.username]));
  }

  const ineLeft = sumBp((n) => !n.eligible && n.leg === 'left');
  const ineRight = sumBp((n) => !n.eligible && n.leg === 'right');
  console.log(`--- INELIGIBLE source accounts the old bug wrongly counted (${ineligible.length}) ---`);
  for (const n of ineligible.slice(0, 80)) {
    console.log(`  ${String(n.leg).toUpperCase().padEnd(5)} uid=${n.uid} @${nameMap[Number(n.uid)] || '?'} `
      + `${CODE[n.codeid] || n.codeid}${n.codeid === 3 ? `(cd=${n.cdstatus})` : ''} bp=${n.bp} reg=${n.datereg} depth=${n.depth}`);
  }
  console.log(`\nineligible points: LEFT=${ineLeft}  RIGHT=${ineRight}`);
  console.log('The ineligible points on the WEAK leg are the direct cause of the excess matched.\n');
  console.log('NOTE: read-only. A CD now fully-paid but UNPAID when the historical pairing was');
  console.log('credited shows as eligible here — cross-check upgradetab / encash dates for the');
  console.log('exact historical CD state if a row looks eligible-now but was the culprit.\n');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
