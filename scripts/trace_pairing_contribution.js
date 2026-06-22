/**
 * READ-ONLY pairing trace: prove a source account's binary value reaches a target upline.
 *
 * Confirms the comp model: when EleonorA01 encoded as Bronze, Elmer's leg gained 250; when she
 * upgraded to Gold, Elmer's leg gained another 1000 (a fresh upgrade binary event). This walks
 * the source -> upline binary (refid) chain, proves the upline is an ancestor, determines WHICH
 * leg of the upline the source sits on, and lists the source's binary EVENTS that the engine
 * collects onto that leg:
 *    base  = usertab.binarypoints (registration tier) on datereg
 *    upgrade(s) = upgradetab(transtype=1).binarypoints on each upgrade date
 * Mirrors pairing.js getNumLevels: a source is collected only if countsForPairingSource(effective)
 * is true, and the engine traverses THROUGH ineligible intermediate nodes, so depth/ineligible
 * uplines in between do not block it. Read-only — reports, never writes.
 *
 * "Collected onto the leg" is proven here; whether a given event became a PAID match depends on
 * the opposite leg's points + weekly/monthly caps on that date (binary mechanics).
 *
 * Usage (BLUE / prod):
 *   NODE_ENV=production node scripts/trace_pairing_contribution.js 7411590 6122895   # EleonorA01 -> Elmer
 */
const { loadBackendEnv, getDbConfig } = require('./env');
const envFile = loadBackendEnv();
const cfg = getDbConfig();
const { pool } = require('../config/database');
const {
  getEffectiveAccountState,
  countsForPairingSource,
  getAccountStateLabel,
} = require('../services/accountState');

const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }

async function main() {
  console.log(`[pairtrace] env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}  (READ-ONLY)`);
  const argv = process.argv.slice(2).map(Number);
  const sourceUid = argv[0] || 7411590; // EleonorA01
  const uplineUid = argv[1] || 6122895; // Elmer143

  const [[src]] = await pool.query(
    `SELECT u.uid, u.refid, u.position, u.accttype, u.currentaccttype, u.codeid, u.cdamount,
            u.cdtotal, u.cdstatus, u.binarypoints, DATE_FORMAT(u.datereg,'%Y-%m-%d') AS datereg,
            m.username
       FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid WHERE u.uid = ? LIMIT 1`,
    [sourceUid]
  );
  if (!src) { console.log(`source uid ${sourceUid} NOT FOUND`); await pool.end(); return; }

  const eff = await getEffectiveAccountState(sourceUid, { ...src });
  const contributes = countsForPairingSource(eff);
  console.log(`\nSOURCE: ${src.username} (uid ${sourceUid})  ${PKG[num(src.accttype)] || src.accttype}->${PKG[num(src.currentaccttype)] || src.currentaccttype}` +
    `${num(src.currentaccttype) > num(src.accttype) ? ' (UPGRADED)' : ''}`);
  console.log(`  effective ${getAccountStateLabel(eff)} -> CONTRIBUTES as binary source? ${contributes ? 'YES' : 'NO'}`);

  // Walk refid chain up to the upline; capture the node whose refid == upline (=> the leg).
  const chain = [];
  let current = sourceUid;
  let legNode = null;
  const seen = new Set([sourceUid]);
  let reached = false;
  for (let i = 0; i < 80; i++) {
    // eslint-disable-next-line no-await-in-loop
    const [[r]] = await pool.query('SELECT refid, position FROM usertab WHERE uid = ? LIMIT 1', [current]);
    const parent = num(r?.refid);
    if (current === uplineUid) { reached = true; break; }
    if (parent === uplineUid) { legNode = { uid: current, position: num(r.position) }; }
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    if (parent === uplineUid) { reached = true; break; }
    current = parent;
  }

  if (!reached) {
    console.log(`\n>>> upline uid ${uplineUid} is NOT a binary ancestor of ${src.username}. Her points do NOT reach it.`);
    await pool.end();
    return;
  }
  const leg = legNode ? (legNode.position === 1 ? 'LEFT' : 'RIGHT') : 'UNKNOWN';
  console.log(`\n>>> ${src.username} sits on uid ${uplineUid}'s ${leg} leg (via uid ${legNode?.uid}, ${chain.length} hops up).`);

  if (!contributes) {
    console.log(`\n>>> But she is NOT an eligible source (${getAccountStateLabel(eff)}) -> contributes 0. Nothing collected.`);
    await pool.end();
    return;
  }

  // The binary EVENTS the engine collects onto that leg for this source.
  console.log(`\nEVENTS collected onto uid ${uplineUid}'s ${leg} leg from ${src.username}:`);
  const baseVal = num(src.binarypoints);
  console.log(`  + ${baseVal}  (base ${PKG[num(src.accttype)] || src.accttype} registration, date ${src.datereg || '-'}, codeid ${num(eff.codeid)})`);
  let total = baseVal;
  const [ups] = await pool.query(
    `SELECT id, producttype, binarypoints, DATE_FORMAT(transdate,'%Y-%m-%d') AS transdate
       FROM upgradetab WHERE uid = ? AND transtype = 1 ORDER BY transdate ASC, id ASC`,
    [sourceUid]
  );
  for (const up of ups) {
    const v = num(up.binarypoints);
    total += v;
    console.log(`  + ${v}  (upgrade to ${PKG[num(up.producttype)] || up.producttype}, date ${up.transdate || '-'}, upgrade event id ${up.id})`);
  }
  console.log(`  = ${total} TOTAL binary value ${src.username} contributes to uid ${uplineUid}'s ${leg} leg.`);
  console.log('\nNOTE: this is what the engine COLLECTS onto the leg (proven). Whether each dated event became a');
  console.log('      PAID match for the upline depends on the OPPOSITE leg points + weekly/monthly caps that day.');

  await pool.end();
}

main().catch((err) => { console.error('[pairtrace] FAILED:', err.message); process.exit(1); });
