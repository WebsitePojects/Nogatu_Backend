/**
 * READ-ONLY: does the pairing engine treat these accounts as binary SOURCES, and why?
 *
 * Uses the ACTUAL engine functions (getLatestUpgradeCode, getEffectiveAccountState,
 * countsForPairingSource) — not a raw codeid guess — to answer the Minutes #5 complaint
 * (Ashanti/Primavesa "di pumapalo kay Elmer").
 *
 * The 2026-04-29 rule: a CD account that UPGRADED via a PAID code is treated as settled and
 * contributes binary. getEffectiveAccountState applies this ONLY if getLatestUpgradeCode can
 * JOIN upgradetab.codeid -> codestab.id and read codetype=1. If that JOIN returns NULL (the
 * upgrade-code link is broken / legacy / points nowhere), the override is SKIPPED and the
 * account stays raw CD-unpaid => NOT a pairing source => its sales match never reaches the
 * upline. This script shows raw vs effective state, the upgrade-code JOIN result, the final
 * contributes? verdict, and whether the target uplines (e.g. Elmer 6122895) sit in its binary
 * ancestor chain. Read-only — reports, never writes.
 *
 * Usage (BLUE / prod):
 *   NODE_ENV=production node scripts/audit_effective_state.js
 *   NODE_ENV=production node scripts/audit_effective_state.js 330766 7266942
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const {
  getLatestUpgradeCode,
  getEffectiveAccountState,
  countsForPairingSource,
  countsForDirectReferralSource,
  getAccountStateLabel,
} = require('../services/accountState');

const DEFAULT_UIDS = [330766, 7266942]; // Ashanti01, Primavesa01
const UPLINE_TARGETS = [6122895, 6548437, 5726452]; // Elmer + their binary parent + Elmer's parent
const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

async function binaryAncestors(uid, targets) {
  // Walk refid upward; report which target uplines are hit and at what depth.
  const hits = {};
  let current = uid;
  const seen = new Set([uid]);
  for (let depth = 1; depth <= 60; depth++) {
    // eslint-disable-next-line no-await-in-loop
    const [[row]] = await pool.query('SELECT refid FROM usertab WHERE uid = ? LIMIT 1', [current]);
    const parent = num(row?.refid);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    if (targets.includes(parent)) hits[parent] = depth;
    current = parent;
  }
  return hits;
}

async function auditOne(uid) {
  const [[raw]] = await pool.query(
    `SELECT u.uid, u.refid, u.position, u.drefid, u.accttype, u.currentaccttype,
            u.codeid, u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints,
            m.username, m.firstname, m.lastname
       FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = ? LIMIT 1`,
    [uid]
  );
  if (!raw) { console.log(`\n===== uid ${uid} — NOT FOUND =====`); return; }

  console.log(`\n===== ${raw.username} (uid ${uid}, ${(raw.firstname || '') + ' ' + (raw.lastname || '')}) =====`);
  console.log(`  package: ${PKG[num(raw.accttype)] || raw.accttype} -> ${PKG[num(raw.currentaccttype)] || raw.currentaccttype}` +
    `${num(raw.currentaccttype) > num(raw.accttype) ? ' (UPGRADED)' : ''}`);
  console.log(`  RAW state: codeid=${num(raw.codeid)} cdstatus=${num(raw.cdstatus)} cdamount=${num(raw.cdamount)} cdtotal=${num(raw.cdtotal)}  => label ${getAccountStateLabel({ codeid: raw.codeid, cdstatus: raw.cdstatus, cdamount: raw.cdamount, cdtotal: raw.cdtotal })}`);

  // The upgrade-code JOIN that drives the override:
  const upgrade = await getLatestUpgradeCode(uid);
  if (num(raw.currentaccttype) > num(raw.accttype)) {
    if (!upgrade) {
      console.log('  UPGRADE-CODE JOIN: *** NULL *** (upgradetab.codeid does NOT join codestab.id) -> override SKIPPED -> stays raw state.');
    } else {
      const ct = num(upgrade.codetype);
      const label = ct === 1 ? 'PAID/PD' : ct === 2 ? 'FS' : ct === 3 ? 'CD' : `codetype=${ct}`;
      console.log(`  UPGRADE-CODE JOIN: codestab.codetype=${ct} (${label}) productamount=${num(upgrade.productamount)}  [upgrade.codeid=${num(upgrade.upgradecodeid)}]`);
    }
  } else {
    console.log('  UPGRADE-CODE JOIN: n/a (no upgrade)');
  }

  // Authoritative effective state, exactly as the engine computes it:
  const eff = await getEffectiveAccountState(uid, { ...raw });
  const contributesPairing = countsForPairingSource(eff);
  const contributesDR = countsForDirectReferralSource(eff);
  console.log(`  EFFECTIVE state: codeid=${num(eff.codeid)} cdstatus=${num(eff.cdstatus)}  => label ${getAccountStateLabel(eff)}`);
  console.log(`  >>> CONTRIBUTES as binary (pairing) source? ${contributesPairing ? 'YES' : 'NO'}    DR source? ${contributesDR ? 'YES' : 'NO'}`);

  // Does its pairing even reach the named uplines?
  const hits = await binaryAncestors(uid, UPLINE_TARGETS);
  const hitStr = Object.keys(hits).length
    ? Object.entries(hits).map(([t, d]) => `uid ${t} @depth ${d}`).join(', ')
    : 'NONE of [' + UPLINE_TARGETS.join(', ') + '] are binary ancestors';
  console.log(`  binary upline (refid chain) contains: ${hitStr}`);

  if (num(raw.currentaccttype) > num(raw.accttype) && num(raw.codeid) === 3 && !contributesPairing) {
    if (!upgrade) {
      console.log('  >>> ROOT CAUSE CANDIDATE: upgraded CD account whose upgrade-code link is BROKEN -> engine cannot see it was paid -> wrongly blocked from pairing its upline.');
    } else if (num(upgrade.codetype) === 1) {
      console.log('  >>> BUG CANDIDATE: paid upgrade code but effective state still non-contributing -> investigate getEffectiveAccountState path.');
    } else {
      console.log(`  >>> WORKING AS DESIGNED: upgrade code was ${num(upgrade.codetype) === 3 ? 'CD' : 'non-paid'} -> stays CD-unpaid until settled (not a bug; needs paid conversion).`);
    }
  }
}

async function main() {
  console.log(`[effstate:audit] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const argv = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const targets = argv.length ? argv : DEFAULT_UIDS;
  try {
    for (const uid of targets) {
      // eslint-disable-next-line no-await-in-loop
      await auditOne(uid);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[effstate:audit] FAILED:', err.message);
  process.exit(1);
});
