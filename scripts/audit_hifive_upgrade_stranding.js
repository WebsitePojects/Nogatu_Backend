/**
 * READ-ONLY audit — Hi-Five PACKAGE sets lost when a direct referral upgrades.
 *
 * THE DEFECT
 * getDirectReferralPackageCounts() counts each direct at their CURRENT package only. When a
 * Bronze direct upgrades to Gold they stop being counted as Bronze, so a Bronze set the upline
 * had ALREADY completed (and already been paid for) disappears from the entitlement total.
 * The monotonic credit rule -- owed = max(0, entitlement - ttlincome5) -- cannot claw that back,
 * so instead it silently absorbs the loss out of the NEXT credit. Nobody ever sees a negative
 * line, which is why this has gone unreported: the upline is simply paid less for their next
 * genuine qualification.
 *
 * Reming001 is the worked example. Four Bronze sets earned and paid (PHP 10,000). Three directs
 * upgraded to Gold, dropping him to three Bronze sets. When the fifth Gold landed, entitlement
 * read PHP 17,500 rather than PHP 20,000, so the Gold set paid PHP 7,500 instead of PHP 10,000.
 *
 * WHY A TIMELINE, NOT A "HAS EVER HELD THIS TIER" COUNT
 * The obvious shortcut -- count a direct in every tier they have ever held -- OVER-counts. Three
 * directs joining Bronze, upgrading to Gold, then two more joining Bronze looks like five "ever
 * Bronze" while the upline never actually held five Bronze at one time, so no Bronze set was ever
 * earned. A set has to have EXISTED at a point in time to have been earned. This script therefore
 * replays every registration and upgrade in chronological order and records the true high-water
 * mark per tier.
 *
 * Eligibility caveat, stated rather than hidden: a direct's tier is replayed over time, but
 * whether they count at all (FS and unpaid CD contribute nothing) is evaluated at their CURRENT
 * state, because historical CD settlement dates are not reconstructible here. A direct who was
 * ineligible earlier and is eligible now is treated as eligible for the whole timeline. That can
 * only ever overstate a gap, never understate one, so every figure below is an UPPER bound and
 * must be confirmed per member before any payment.
 *
 * Writes nothing. No transaction, no UPDATE, no INSERT.
 *
 *   NODE_ENV=production node scripts/audit_hifive_upgrade_stranding.js
 *   NODE_ENV=production node scripts/audit_hifive_upgrade_stranding.js --uid 2015475
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const { getEffectiveAccountState } = require('../services/accountState');
const { countsForDirectReferralSource } = require('../services/income/directReferral');

const TIERS = [
  { code: 10, key: 'bronze',   name: 'Bronze' },
  { code: 20, key: 'silver',   name: 'Silver' },
  { code: 30, key: 'gold',     name: 'Gold' },
  { code: 40, key: 'platinum', name: 'Platinum' },
  { code: 50, key: 'garnet',   name: 'Garnet' },
  { code: 60, key: 'diamond',  name: 'Diamond' },
];
const TIER_BY_CODE = Object.fromEntries(TIERS.map((t) => [t.code, t]));

const onlyUidArg = process.argv.indexOf('--uid');
const ONLY_UID = onlyUidArg > -1 ? Number(process.argv[onlyUidArg + 1]) : null;

const peso = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });

/** Reward per tier, read the same way the engine reads it (MAX productamount per package code). */
async function loadRewards() {
  const [rows] = await pool.query(
    `SELECT producttype, MAX(productamount) amount FROM codestab
      WHERE producttype IN (10,20,30,40,50,60) GROUP BY producttype`
  );
  const rewards = {};
  for (const r of rows) {
    const tier = TIER_BY_CODE[Number(r.producttype)];
    if (tier) rewards[tier.key] = Number(r.amount || 0);
  }
  return rewards;
}

/**
 * Replay a member's directs chronologically and return the highest simultaneous count each tier
 * ever reached, alongside the count as the live engine sees it today.
 */
function replayTimeline(directs, upgradesByUid) {
  const events = [];
  for (const d of directs) {
    const joinTier = Number(d.accttype) || 0;
    if (TIER_BY_CODE[joinTier]) {
      events.push({ ts: new Date(d.datereg).getTime(), uid: d.uid, to: joinTier });
    }
    for (const up of (upgradesByUid.get(Number(d.uid)) || [])) {
      if (TIER_BY_CODE[up.tier]) {
        events.push({ ts: new Date(up.transdate).getTime(), uid: d.uid, to: up.tier });
      }
    }
  }
  // Ties are broken by tier so a same-instant leave/join nets out deterministically.
  events.sort((a, b) => a.ts - b.ts || a.to - b.to);

  const live = new Map();               // uid -> tier held right now in the replay
  const counts = Object.fromEntries(TIERS.map((t) => [t.key, 0]));
  const highWater = Object.fromEntries(TIERS.map((t) => [t.key, 0]));

  for (const ev of events) {
    const prev = live.get(ev.uid);
    if (prev && TIER_BY_CODE[prev]) counts[TIER_BY_CODE[prev].key] -= 1;
    live.set(ev.uid, ev.to);
    const key = TIER_BY_CODE[ev.to].key;
    counts[key] += 1;
    if (counts[key] > highWater[key]) highWater[key] = counts[key];
  }

  return { highWater, current: counts };
}

function entitlementOf(countsByKey, rewards) {
  let total = 0;
  const detail = [];
  for (const t of TIERS) {
    const sets = Math.floor(Number(countsByKey[t.key] || 0) / 5);
    if (sets > 0) {
      const value = sets * Number(rewards[t.key] || 0);
      total += value;
      detail.push(`${t.name} ${sets}x${peso(rewards[t.key])}=${peso(value)}`);
    }
  }
  return { total, detail };
}

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}  mode=READ-ONLY (writes nothing)`);

  const rewards = await loadRewards();
  console.log('rewards:', TIERS.map((t) => `${t.name}=${peso(rewards[t.key])}`).join('  '), '\n');

  const [uplines] = ONLY_UID
    ? await pool.query('SELECT DISTINCT drefid uid FROM usertab WHERE drefid = ?', [ONLY_UID])
    : await pool.query('SELECT DISTINCT drefid uid FROM usertab WHERE drefid IS NOT NULL AND drefid <> 0');
  console.log(`uplines to examine: ${uplines.length}\n`);

  // One pass for every upgrade, keyed by member, so the replay needs no per-member query.
  const [allUpgrades] = await pool.query(
    `SELECT up.uid, c.producttype tier, up.transdate
       FROM upgradetab up INNER JOIN codestab c ON c.id = up.codeid
      WHERE c.producttype IN (10,20,30,40,50,60)
      ORDER BY up.transdate ASC`
  );
  const upgradesByUid = new Map();
  for (const up of allUpgrades) {
    const uid = Number(up.uid);
    if (!upgradesByUid.has(uid)) upgradesByUid.set(uid, []);
    upgradesByUid.get(uid).push({ tier: Number(up.tier), transdate: up.transdate });
  }

  const findings = [];
  let examined = 0;

  for (const row of uplines) {
    const uid = Number(row.uid);
    examined += 1;

    const [directs] = await pool.query(
      `SELECT child.uid, child.accttype, child.currentaccttype, child.codeid,
              child.cdamount, child.cdtotal, child.cdstatus, child.datereg
         FROM usertab child WHERE child.drefid = ?`,
      [uid]
    );
    if (directs.length < 5) continue;   // cannot hold a set of five

    const eligible = [];
    for (const d of directs) {
      const effective = await getEffectiveAccountState(d.uid, d);
      if (countsForDirectReferralSource(effective)) eligible.push(d);
    }
    if (eligible.length < 5) continue;

    const { highWater, current } = replayTimeline(eligible, upgradesByUid);
    const earned = entitlementOf(highWater, rewards);
    const asPaidBasis = entitlementOf(current, rewards);
    if (earned.total <= asPaidBasis.total) continue;

    const [[tot]] = await pool.query(
      'SELECT COALESCE(ttlincome5,0) paid FROM payouttotaltab WHERE uid = ?', [uid]
    );
    const [[who2]] = await pool.query('SELECT username FROM memberstab WHERE uid = ?', [uid]);

    findings.push({
      uid,
      username: who2 ? who2.username : `uid ${uid}`,
      earned: earned.total,
      engine: asPaidBasis.total,
      paid: Number(tot ? tot.paid : 0),
      shortfall: earned.total - Number(tot ? tot.paid : 0),
      earnedDetail: earned.detail.join(', '),
      engineDetail: asPaidBasis.detail.join(', '),
    });
  }

  findings.sort((a, b) => b.shortfall - a.shortfall);

  console.log('='.repeat(100));
  console.log('MEMBERS WHOSE EARNED SETS EXCEED WHAT THE ENGINE NOW COMPUTES');
  console.log('='.repeat(100));
  for (const f of findings) {
    console.log(`\n${f.username} (uid ${f.uid})`);
    console.log(`  earned at high-water : ${peso(f.earned)}   [${f.earnedDetail}]`);
    console.log(`  engine computes now  : ${peso(f.engine)}   [${f.engineDetail}]`);
    console.log(`  already paid         : ${peso(f.paid)}`);
    console.log(`  SHORTFALL            : ${peso(f.shortfall)}${f.shortfall <= 0 ? '  (none owed)' : ''}`);
  }

  const owed = findings.filter((f) => f.shortfall > 0);
  console.log('\n' + '='.repeat(100));
  console.log(`uplines examined      : ${examined}`);
  console.log(`members with lost sets: ${findings.length}`);
  console.log(`members actually owed : ${owed.length}`);
  console.log(`TOTAL SHORTFALL       : ${peso(owed.reduce((s, f) => s + f.shortfall, 0))}`);
  console.log('='.repeat(100));
  console.log('\nRead-only. Nothing was written. Figures are an UPPER bound (see header note on eligibility).');

  await pool.end();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
