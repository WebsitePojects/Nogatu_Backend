/**
 * READ-ONLY DIAGNOSTIC: why an account is/ isn't receiving pairing (PV), with a focus on
 * the inherited legacy-upgrade bug (upgraded accounts whose upgrade binary points never
 * flow upstream because the legacy PHP system credited uplines manually and never wrote a
 * usable `upgradetab transtype=1` row).
 *
 * For each target account it prints, in order, EVERY gate the pairing engine applies:
 *   1. raw usertab identity (accttype vs currentaccttype, codeid, cd*, binarypoints, tree links)
 *   2. isUpgraded (accttype < currentaccttype) + upgradetab transtype=1 rows (the upgrade events)
 *      -> FLAGS the legacy gap: "upgraded but NO usable upgrade event row"
 *   3. effective account state (getEffectiveAccountState) + countsForPairingSource
 *   4. earn gate (getBinaryPairingEligibility): canEarnPairing, qualified directs per leg
 *   5. pairing engine (getPairing): totalPay / legs vs stored payouttotaltab.ttlincome2
 *   6. downline upgrade-gap scan: how many nodes in this account's binary subtree are
 *      upgraded-by-accttype but have NO upgradetab transtype=1 row (their upgrade PV is lost)
 *
 * Then a PORTFOLIO summary: total accounts upgraded-by-accttype vs how many lack a usable
 * upgrade event row (the size of the inherited bug).
 *
 * Usage:
 *   NODE_ENV=production node scripts/diagnose_upgrade_pairing.js [name_or_uid ...]
 *   (defaults to: Ashanti Primavesa Eleonor Neneng01 Teodolo)
 *
 * READ-ONLY. No INSERT/UPDATE/DELETE. Safe on blue (prod).
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const DEFAULT_TARGETS = ['Ashanti', 'Primavesa', 'Eleonor', 'Neneng01', 'Teodolo'];
const CODE = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const targets = process.argv.slice(2);
  const list = targets.length ? targets : DEFAULT_TARGETS;
  console.log(`\n[diagnose_upgrade_pairing] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log(`targets: ${list.join(', ')}\n`);

  const { pool } = require('../config/database');
  const { getEffectiveAccountState, countsForPairingSource, getAccountStateLabel } = require('../services/accountState');
  const { getBinaryPairingEligibility } = require('../services/binaryEligibility');
  const { getPairing } = require('../services/income/pairing');

  async function resolve(token) {
    const [rows] = await pool.query(
      `SELECT u.uid, u.refid, u.drefid, u.position, u.codeid, u.accttype, u.currentaccttype,
              u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints,
              DATE_FORMAT(u.datereg,'%Y-%m-%d') AS datereg,
              m.username, COALESCE(p.ttlincome2,0) AS smb
         FROM usertab u
         JOIN memberstab m ON m.uid = u.uid
         LEFT JOIN payouttotaltab p ON p.uid = u.uid
        WHERE m.username = ? OR u.uid = ?
        ORDER BY u.uid ASC`,
      [String(token), Number(token) || 0]
    );
    return rows;
  }

  for (const token of list) {
    const matches = await resolve(token);
    if (!matches.length) { console.log(`\n========== ${token}: NOT FOUND ==========\n`); continue; }

    for (const me of matches) {
      const uid = Number(me.uid);
      const isUpgraded = Number(me.accttype || 0) < Number(me.currentaccttype || 0);

      console.log(`\n========== @${me.username} (uid=${uid}) ==========`);
      console.log(`raw: codeid=${me.codeid}(${CODE[me.codeid] || '?'}) accttype=${me.accttype} currentaccttype=${me.currentaccttype} ` +
        `cdstatus=${me.cdstatus} cd=${me.cdtotal}/${me.cdamount} binarypoints=${me.binarypoints} reg=${me.datereg}`);
      console.log(`tree: refid(binary parent)=${me.refid} position=${me.position} drefid(sponsor)=${me.drefid}`);
      console.log(`isUpgraded (accttype<currentaccttype): ${isUpgraded}`);

      // 2. upgrade events
      const [ups] = await pool.query(
        `SELECT u.id, u.producttype, u.codeid, u.binarypoints,
                DATE_FORMAT(u.transdate,'%Y-%m-%d') AS transdate,
                c.id AS code_ok, c.codetype, c.productamount
           FROM upgradetab u
           LEFT JOIN codestab c ON c.id = u.codeid
          WHERE u.uid = ? AND u.transtype = 1
          ORDER BY u.transdate ASC, u.id ASC`,
        [uid]
      );
      console.log(`upgradetab transtype=1 rows: ${ups.length}`);
      for (const r of ups) {
        console.log(`   - prod=${r.producttype} bp=${r.binarypoints} date=${r.transdate} codeid=${r.codeid} ` +
          `codestabJoin=${r.code_ok ? `ok(codetype=${r.codetype})` : 'MISSING'}`);
      }
      if (isUpgraded && ups.length === 0) {
        console.log(`   >>> LEGACY GAP: account is upgraded (accttype<currentaccttype) but has NO usable upgrade event.`);
        console.log(`   >>> appendUpgradePairingBonus() finds nothing -> its upgrade PV never flows to its upline.`);
      }
      if (!isUpgraded && Number(me.currentaccttype) > 0 && ups.length > 0) {
        console.log(`   >>> NOTE: has upgrade rows but accttype==currentaccttype (accttype may have been bumped by legacy upgrade).`);
      }

      // 3. effective state
      const eff = await getEffectiveAccountState(uid, { ...me });
      console.log(`effective: codeid=${eff.codeid}(${CODE[eff.codeid] || '?'}) cdstatus=${eff.cdstatus} ` +
        `label=${getAccountStateLabel(eff)} countsAsSource=${countsForPairingSource(eff)}`);

      // 4. earn gate
      const elig = await getBinaryPairingEligibility(uid);
      console.log(`EARN GATE canEarnPairing=${elig.canEarnPairing} leftQualified=${elig.leftQualifiedCount} rightQualified=${elig.rightQualifiedCount}` +
        (elig.missingLegs.length ? ` missingLegs=${elig.missingLegs.join(',')}` : ''));
      if (!elig.canEarnPairing) console.log(`   reason: ${elig.reason}`);

      // 5. engine vs stored
      const res = await getPairing(uid, Number(me.currentaccttype || 0));
      const stored = Number(me.smb || 0);
      const engine = Number(res.totalPay || 0);
      console.log(`ENGINE getPairing: totalPay=${engine} leftPts=${res.leftPts} rightPts=${res.rightPts} ` +
        `paired=${res.pairedPts} (canEarn=${res.eligibility?.canEarnPairing})`);
      console.log(`STORED ttlincome2 (already-credited SMB) = ${stored}`);
      const delta = engine - stored;
      console.log(`engine - stored = ${delta} ${delta > 0 ? '(engine would credit this much MORE on next recompute)' :
        delta < 0 ? '(stored exceeds engine — legacy/manual credit retained; Math.max credits nothing)' : '(in sync)'}`);

      // 6. downline upgrade-gap scan via closure (fast, read-only)
      try {
        const [gap] = await pool.query(
          `SELECT
              SUM(CASE WHEN u.accttype < u.currentaccttype THEN 1 ELSE 0 END) AS upgraded_nodes,
              SUM(CASE WHEN u.accttype < u.currentaccttype
                        AND NOT EXISTS (SELECT 1 FROM upgradetab g WHERE g.uid=u.uid AND g.transtype=1)
                       THEN 1 ELSE 0 END) AS upgraded_no_event
             FROM binary_tree_closuretab c
             JOIN usertab u ON u.uid = c.descendant_uid
            WHERE c.ancestor_uid = ? AND c.depth > 0`,
          [uid]
        );
        const g = gap[0] || {};
        console.log(`downline (binary subtree): upgraded nodes=${Number(g.upgraded_nodes || 0)}, ` +
          `of which MISSING upgrade event (legacy gap, PV lost upstream)=${Number(g.upgraded_no_event || 0)}`);
      } catch (e) {
        console.log(`downline scan skipped (${e.code || e.message})`);
      }
    }
  }

  // PORTFOLIO: size of the inherited bug
  console.log(`\n\n===== PORTFOLIO: legacy-upgrade gap across all accounts =====`);
  const [[port]] = await pool.query(
    `SELECT
        SUM(CASE WHEN accttype < currentaccttype THEN 1 ELSE 0 END) AS upgraded_by_accttype,
        SUM(CASE WHEN accttype < currentaccttype
                  AND NOT EXISTS (SELECT 1 FROM upgradetab g WHERE g.uid=usertab.uid AND g.transtype=1)
                 THEN 1 ELSE 0 END) AS upgraded_missing_event
       FROM usertab`
  );
  console.log(`accounts upgraded (accttype<currentaccttype):        ${Number(port.upgraded_by_accttype || 0)}`);
  console.log(`  ...of which have NO usable upgrade event row:      ${Number(port.upgraded_missing_event || 0)}  <-- inherited bug population`);
  console.log(`\nNOTE: read-only. No remediation performed. A fix must be per-account reconciled`);
  console.log(`(engine-with-event vs stored ttlincome2) so Math.max only ever raises to the correct`);
  console.log(`total and never double-pays the legacy manual credit. Review before any write.\n`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
