/**
 * READ-ONLY: find Gold/Garnet accounts in a binary subtree that do NOT contribute pairing.
 *
 * Minutes #5 refined: "6 Garnet entries under Ashanti/Primavesa don't pair / credit up to
 * Elmer." A high-tier account contributes ZERO binary if its EFFECTIVE state is not an
 * eligible source (FS, CD-unpaid, or an upgraded-CD whose upgrade code was CD / whose
 * upgrade-code link is broken). Then its package binary value never reaches any upline —
 * including Elmer. This walks the binary subtree (refid) under the given root, filters to
 * Gold(30)+Garnet(50), and reports each one's RAW vs EFFECTIVE state (real engine fns), the
 * contributes? verdict, the reason it is blocked, and the binary value that is NOT reaching
 * the upline. Read-only — reports, never writes.
 *
 * Usage (BLUE / prod):
 *   NODE_ENV=production node scripts/audit_pairing_sources.js                # root = Elmer 6122895
 *   NODE_ENV=production node scripts/audit_pairing_sources.js 6548437        # root = Ashanti/Primavesa branch
 *   NODE_ENV=production node scripts/audit_pairing_sources.js 6122895 10 20 30 40 50 60   # root + which tiers
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const {
  getLatestUpgradeCode,
  getEffectiveAccountState,
  countsForPairingSource,
  getAccountStateLabel,
} = require('../services/accountState');

const BINARY_VALUE = { 10: 250, 20: 500, 30: 1000, 40: 2500, 50: 5000, 60: 15000 };
const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

async function blockedReason(row, eff) {
  const code = num(eff.codeid);
  if (code === 2) return 'FS — earns but never a source';
  if (code === 3) {
    if (num(row.currentaccttype) > num(row.accttype)) {
      const up = await getLatestUpgradeCode(num(row.uid));
      if (!up) return 'upgraded-CD, BROKEN upgrade-code link (upgradetab.codeid !-> codestab.id) — override skipped';
      const ct = num(up.codetype);
      if (ct === 3) return `upgraded via CD code — unpaid (${num(eff.cdtotal)}/${num(eff.cdamount)})`;
      if (ct === 1) return 'paid upgrade code but still non-contributing — INVESTIGATE';
      return `upgrade codetype=${ct}`;
    }
    return `registered CD — unpaid (${num(eff.cdtotal)}/${num(eff.cdamount)})`;
  }
  return `codeid=${code}`;
}

async function main() {
  console.log(`[pairsrc:audit] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const argv = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const root = argv[0] || 6122895; // default Elmer
  const tiers = argv.slice(1).length ? argv.slice(1) : [30, 50]; // default Gold + Garnet
  const tierList = tiers.join(',');
  console.log(`[pairsrc:audit] root uid=${root}  tiers=[${tiers.map((t) => PKG[t] || t).join(', ')}]`);

  const [rows] = await pool.query(
    `WITH RECURSIVE bt AS (
       SELECT uid, refid, 0 AS d FROM usertab WHERE uid = ?
       UNION ALL
       SELECT c.uid, c.refid, b.d + 1 FROM bt b JOIN usertab c ON c.refid = b.uid AND c.uid <> b.uid
        WHERE b.d < 60
     )
     SELECT bt.uid, bt.d AS depth, u.accttype, u.currentaccttype, u.codeid,
            u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints, m.username
       FROM bt
       JOIN usertab u ON u.uid = bt.uid
       LEFT JOIN memberstab m ON m.uid = bt.uid
      WHERE bt.d > 0 AND u.currentaccttype IN (${tierList})
      ORDER BY u.currentaccttype DESC, bt.d ASC`,
    [root]
  );

  console.log(`\nFound ${rows.length} ${tiers.map((t) => PKG[t]).join('/')} account(s) in the subtree.\n`);
  const blockedByTier = {};
  let blockedValue = 0;

  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const eff = await getEffectiveAccountState(num(r.uid), { ...r });
    const contributes = countsForPairingSource(eff);
    const tier = num(r.currentaccttype);
    const expected = num(BINARY_VALUE[tier]);
    if (!contributes) {
      // eslint-disable-next-line no-await-in-loop
      const reason = await blockedReason(r, eff);
      blockedByTier[tier] = (blockedByTier[tier] || 0) + 1;
      blockedValue += expected;
      console.log(`  BLOCKED  ${PKG[tier]}  uid ${r.uid} ${r.username || ''}  depth ${num(r.depth)}  ` +
        `raw[codeid=${num(r.codeid)} cdstatus=${num(r.cdstatus)}] -> eff ${getAccountStateLabel(eff)}  ` +
        `binaryValue ${expected} NOT reaching upline  :: ${reason}`);
    }
  }

  console.log('\n========== SUMMARY ==========');
  for (const tier of tiers) {
    const total = rows.filter((r) => num(r.currentaccttype) === tier).length;
    const blocked = blockedByTier[tier] || 0;
    console.log(`  ${PKG[tier]}: ${total} total, ${blocked} BLOCKED (non-contributing), ${total - blocked} contributing.`);
  }
  console.log(`  Total binary value NOT reaching the upline from blocked Gold/Garnet: ${blockedValue}`);
  console.log('  NOTE: BLOCKED accounts contribute 0 to EVERY upline on their leg (incl. Elmer). Resolution is operational');
  console.log('        (settle the CD / convert to a paid code / fix a broken upgrade-code link) — not an engine change.');

  await pool.end();
}

main().catch((err) => {
  console.error('[pairsrc:audit] FAILED:', err.message);
  process.exit(1);
});
