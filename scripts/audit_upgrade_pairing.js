/**
 * READ-ONLY #5 diagnostic — "upgraded accounts not triggering pairing".
 *
 * For each target account (and a population scan) it reports, using the REAL engine
 * functions (getEffectiveAccountState + countsForPairingSource), WHY the account is or is
 * not a pairing SOURCE, and whether its upgrade PV can flow upstream.
 *
 * Root-cause hypotheses this surfaces (no fix, report only):
 *   A. raw CD unpaid, never upgraded            -> correctly blocked (not a bug).
 *   B. upgraded via PAID code (codetype=1)       -> should be settled+source. If still blocked,
 *      the upgrade override failed to resolve.
 *   C. UPGRADE LINK BROKEN: usertab.accttype < currentaccttype (upgraded) but the latest
 *      upgradetab row's codeid does NOT inner-join a codestab row (codetype unknown) -> the
 *      paid-upgrade settlement in getEffectiveAccountState silently no-ops -> a raw-CD account
 *      stays CD-unpaid and never becomes a pairing source. PRIME #5 SUSPECT.
 *   D. MODERN upgrade with NO transtype=1 row    -> appendUpgradePairingBonus has nothing to
 *      replay, so the upgrade PV never reaches the upline (base PV still flows if source).
 *
 * Usage:
 *   GREEN (staging): node scripts/audit_upgrade_pairing.js [name_or_uid ...]
 *   BLUE  (prod):    NODE_ENV=production node scripts/audit_upgrade_pairing.js [name_or_uid ...]
 * Defaults to the reported accounts when no args are given. READ-ONLY. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const DEFAULT_TARGETS = ['Ashanti01', 'Primavesa01', 'Neneng01', 'Teodolo001', 'EleonorA01', 'EleonorB01', 'EleonorMiranda'];
const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_upgrade_pairing] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);

  const { pool } = require('../config/database');
  const { getEffectiveAccountState, countsForPairingSource, getAccountStateLabel } = require('../services/accountState');

  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;

  async function resolveUid(t) {
    if (/^\d+$/.test(t)) return Number(t);
    const [r] = await pool.query('SELECT uid FROM memberstab WHERE username = ? LIMIT 1', [t]);
    return r.length ? Number(r[0].uid) : null;
  }

  console.log('\n=== TARGET ACCOUNTS ===');
  for (const t of targets) {
    const uid = await resolveUid(t);
    if (!uid) { console.log(`\n${t}: not found`); continue; }

    const [[u]] = await pool.query(
      `SELECT uid, accttype, currentaccttype, codeid, cdamount, cdtotal, cdstatus, binarypoints, refid, position
         FROM usertab WHERE uid = ? LIMIT 1`, [uid]
    );
    if (!u) { console.log(`\n${t} (uid ${uid}): no usertab row`); continue; }

    // Latest transtype=1 upgrade row + whether its codeid resolves a codestab row.
    const [upg] = await pool.query(
      `SELECT up.id, up.producttype, up.transtype, up.codeid, up.binarypoints,
              DATE_FORMAT(up.transdate,'%Y-%m-%d') AS transdate,
              c.id AS code_join, c.codetype, c.productamount
         FROM upgradetab up
         LEFT JOIN codestab c ON c.id = up.codeid
        WHERE up.uid = ? AND up.transtype = 1
        ORDER BY up.transdate DESC, up.id DESC`, [uid]
    );

    const eff = await getEffectiveAccountState(uid, u).catch((e) => ({ _err: e.message }));
    const isSource = !eff?._err ? countsForPairingSource(eff) : false;
    const label = !eff?._err ? getAccountStateLabel(eff) : 'ERR';

    const upgraded = Number(u.accttype) < Number(u.currentaccttype);
    let reason;
    if (isSource) reason = 'OK — counts as pairing source (base PV flows; upgrade PV flows if transtype=1 row exists)';
    else if (Number(u.codeid) === 2) reason = 'FS — by rule never a source';
    else if (!upgraded && Number(u.codeid) === 3) reason = 'raw CD, never upgraded — blocked until cdstatus=2 (likely correct)';
    else if (upgraded && upg.length && upg[0].code_join == null) reason = '⚠ UPGRADE LINK BROKEN: upgradetab.codeid does not join codestab → paid-upgrade settlement no-ops (PRIME #5 SUSPECT)';
    else if (upgraded && upg.length && Number(upg[0].codetype) === 1) reason = '⚠ upgraded via PAID code but NOT a source — override failed unexpectedly (investigate)';
    else if (upgraded && upg.length && Number(upg[0].codetype) === 3) reason = 'upgraded via CD code → stays CD until the NEW obligation is paid (by rule)';
    else if (upgraded && !upg.length) reason = '⚠ upgraded (accttype<current) but NO transtype=1 row → upgrade PV cannot replay upstream';
    else reason = 'blocked — see fields';

    console.log(`\n${t} (uid ${uid})`);
    console.log(`  pkg: ${PKG[u.accttype]||u.accttype}(${u.accttype}) -> ${PKG[u.currentaccttype]||u.currentaccttype}(${u.currentaccttype})  upgraded=${upgraded}`);
    console.log(`  raw: codeid=${u.codeid} cdstatus=${u.cdstatus} cdamount=${u.cdamount} cdtotal=${u.cdtotal} binarypoints=${u.binarypoints} refid=${u.refid} pos=${u.position}`);
    console.log(`  eff: codeid=${eff?.codeid} cdstatus=${eff?.cdstatus} label=${label}  -> isPairingSource=${isSource}`);
    if (upg.length) {
      for (const r of upg) {
        console.log(`  upgradetab tt1: to ${PKG[r.producttype]||r.producttype} bp=${r.binarypoints} date=${r.transdate} codeid=${r.codeid} ` +
          `codestab_join=${r.code_join == null ? 'NONE ⚠' : `id ${r.code_join} codetype=${r.codetype} amount=${r.productamount}`}`);
      }
    } else {
      console.log('  upgradetab tt1: (none)');
    }
    console.log(`  VERDICT: ${reason}`);
  }

  // Population scan: every upgraded account, bucketed by why it does / does not contribute.
  console.log('\n\n=== POPULATION SCAN (all upgraded: accttype < currentaccttype) ===');
  const [ups] = await pool.query(
    `SELECT u.uid, u.accttype, u.currentaccttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal
       FROM usertab u
      WHERE u.accttype < u.currentaccttype`
  );
  const buckets = { source_pd: 0, source_cd_paid: 0, fs: 0, cd_unpaid_blocked: 0,
                    link_broken: 0, no_transtype1: 0, paid_but_blocked: 0, other_blocked: 0 };
  const suspects = [];
  for (const u of ups) {
    const [upg] = await pool.query(
      `SELECT up.codeid, c.id AS code_join, c.codetype
         FROM upgradetab up LEFT JOIN codestab c ON c.id = up.codeid
        WHERE up.uid = ? AND up.transtype = 1 ORDER BY up.transdate DESC, up.id DESC LIMIT 1`, [u.uid]
    );
    const eff = await getEffectiveAccountState(u.uid, u).catch(() => null);
    const isSource = eff ? countsForPairingSource(eff) : false;
    if (isSource) { buckets[Number(eff.codeid) === 1 ? 'source_pd' : 'source_cd_paid'] += 1; continue; }
    if (Number(u.codeid) === 2) { buckets.fs += 1; continue; }
    if (!upg.length) { buckets.no_transtype1 += 1; suspects.push([u.uid, 'no transtype=1 row']); continue; }
    if (upg[0].code_join == null) { buckets.link_broken += 1; suspects.push([u.uid, 'upgrade link broken']); continue; }
    if (Number(upg[0].codetype) === 1) { buckets.paid_but_blocked += 1; suspects.push([u.uid, 'paid-upgrade but blocked']); continue; }
    if (Number(upg[0].codetype) === 3) { buckets.cd_unpaid_blocked += 1; continue; }
    buckets.other_blocked += 1; suspects.push([u.uid, 'other']);
  }
  console.log(`  upgraded accounts: ${ups.length}`);
  console.log(`  contributing sources : PD=${buckets.source_pd}  CD-paid=${buckets.source_cd_paid}`);
  console.log(`  correctly blocked    : FS=${buckets.fs}  CD-upgrade-unpaid=${buckets.cd_unpaid_blocked}`);
  console.log(`  ⚠ SUSPECT (upgrade PV may not flow):`);
  console.log(`      link-broken (codeid !-> codestab) = ${buckets.link_broken}`);
  console.log(`      paid-upgrade but blocked           = ${buckets.paid_but_blocked}`);
  console.log(`      no transtype=1 row                 = ${buckets.no_transtype1}`);
  console.log(`      other                              = ${buckets.other_blocked}`);
  if (suspects.length) {
    console.log('  suspect uids (first 40):');
    console.log('    ' + suspects.slice(0, 40).map(([id, why]) => `${id}:${why}`).join('  '));
  }

  console.log('\nDone (read-only).');
  await pool.end().catch(() => {});
}

main().catch((err) => { console.error('[audit_upgrade_pairing] ERROR:', err); process.exit(1); });
