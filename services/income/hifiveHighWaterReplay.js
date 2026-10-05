/**
 * Replays a member's direct referrals (registrations + package upgrades) in time order and returns
 * the highest number of same-tier directs held AT ONE TIME, per tier. This is how a Hi-Five package
 * set that later dissolved (because directs upgraded out of the tier) is proven to have existed.
 *
 * Used by the read-only stranding audit and by the one-off 2026-09-25 correction. The live engine
 * does not replay history: it records high-water as it observes counts (V050).
 *
 * Why a timeline and not "has ever held this tier": three directs joining Bronze, upgrading to
 * Gold, then two more joining Bronze would count five "ever Bronze" while the member never held
 * five Bronze at once, so no Bronze set was ever earned.
 *
 * Eligibility (FS / unpaid CD contribute nothing) is judged at the direct's CURRENT state because
 * historical CD settlement dates are not reconstructible. That can only overstate a high-water,
 * never understate it, so a replayed figure must be confirmed before it is paid.
 */
const { getEffectiveAccountState } = require('../accountState');
const { countsForDirectReferralSource } = require('./directReferral');

const TIERS = [
  { code: 10, key: 'bronze', name: 'Bronze' },
  { code: 20, key: 'silver', name: 'Silver' },
  { code: 30, key: 'gold', name: 'Gold' },
  { code: 40, key: 'platinum', name: 'Platinum' },
  { code: 50, key: 'garnet', name: 'Garnet' },
  { code: 60, key: 'diamond', name: 'Diamond' },
];
const TIER_BY_CODE = Object.fromEntries(TIERS.map((t) => [t.code, t]));

const zeroCounts = () => Object.fromEntries(TIERS.map((t) => [t.key, 0]));

/** Directs of `uid` that count as Hi-Five sources, evaluated at their current state. */
async function loadEligibleDirects(db, uid) {
  const [directs] = await db.query(
    `SELECT child.uid, child.accttype, child.currentaccttype, child.codeid,
            child.cdamount, child.cdtotal, child.cdstatus, child.datereg
       FROM usertab child WHERE child.drefid = ?`,
    [uid]
  );
  const eligible = [];
  for (const d of directs) {
    const effective = await getEffectiveAccountState(d.uid, d);
    if (countsForDirectReferralSource(effective)) eligible.push(d);
  }
  return eligible;
}

/**
 * Package upgrades keyed by member uid. Pass `uids` to load only those members' upgrades;
 * omit it to load every upgrade (the whole-base audit).
 */
async function loadUpgradesByUid(db, uids = null) {
  if (Array.isArray(uids) && uids.length === 0) return new Map();
  const params = [];
  let scope = '';
  if (Array.isArray(uids)) {
    scope = 'AND up.uid IN (?)';
    params.push(uids.map(Number));
  }
  const [rows] = await db.query(
    `SELECT up.uid, c.producttype tier, up.transdate
       FROM upgradetab up INNER JOIN codestab c ON c.id = up.codeid
      WHERE c.producttype IN (10,20,30,40,50,60) ${scope}
      ORDER BY up.transdate ASC`,
    params
  );
  const byUid = new Map();
  for (const up of rows) {
    const uid = Number(up.uid);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ tier: Number(up.tier), transdate: up.transdate });
  }
  return byUid;
}

/** Highest simultaneous same-tier count per tier, and the counts at the end of the replay. */
function replayTimeline(directs, upgradesByUid) {
  const events = [];
  for (const d of directs) {
    const joinTier = Number(d.accttype) || 0;
    if (TIER_BY_CODE[joinTier]) {
      events.push({ ts: new Date(d.datereg).getTime(), uid: Number(d.uid), to: joinTier });
    }
    for (const up of (upgradesByUid.get(Number(d.uid)) || [])) {
      if (TIER_BY_CODE[up.tier]) {
        events.push({ ts: new Date(up.transdate).getTime(), uid: Number(d.uid), to: up.tier });
      }
    }
  }
  // Ties broken by tier so a same-instant leave/join nets out deterministically.
  events.sort((a, b) => a.ts - b.ts || a.to - b.to);

  const live = new Map();
  const current = zeroCounts();
  const highWater = zeroCounts();
  for (const ev of events) {
    const prev = live.get(ev.uid);
    if (prev && TIER_BY_CODE[prev]) current[TIER_BY_CODE[prev].key] -= 1;
    live.set(ev.uid, ev.to);
    const key = TIER_BY_CODE[ev.to].key;
    current[key] += 1;
    if (current[key] > highWater[key]) highWater[key] = current[key];
  }
  return { highWater, current };
}

module.exports = { TIERS, TIER_BY_CODE, loadEligibleDirects, loadUpgradesByUid, replayTimeline };
