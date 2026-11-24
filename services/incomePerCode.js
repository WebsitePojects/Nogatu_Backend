/**
 * Income per activation code (management request 2026-11-10 / 2026-11-23, Sir Dino item 8).
 *
 * "One Gold: what does it trigger (direct referral, SMB, leadership)? How many SMB (0, 2, 4)?"
 *
 * READ-ONLY. The wallet ledger (payouthistorytab) records WHO was credited and WHEN, never which
 * code caused it, so per-code figures cannot be read back from the ledger. They are recomputed BY
 * RULE with the live engine's own functions, on one in-memory snapshot:
 *
 *   Direct referral  the sponsor's DR for this direct (usertab.directreferral, or the upgrade
 *                    row's incentivepoints), only when the member counts as a DR source today
 *                    (getEffectiveAccountState + countsForDirectReferralSource, as getDREF does).
 *   SMB              every binary upline's pairing is replayed exactly like
 *                    pairing.js getNumLevels + totalPairingAmount (same day buckets, carry
 *                    counters, weekly/monthly caps, eligibility gate). Each day's CREDITED pesos
 *                    are split over the points that day's match consumed, oldest points first
 *                    (the carry is the oldest unmatched points), half to the left source and
 *                    half to the right source. The shares of all codes add up to the engine
 *                    total for every upline, which the report checks.
 *   Leadership       5/2/1/1/1% of each SMB share, up the earner's sponsor line, only when the
 *                    earner counts as a leadership source (leadership.js uses the raw row).
 *
 * Hi-Five and unilevel are not attributed per code (they depend on sets of directs and monthly
 * repurchase volume, not on one code); the monthly income-release report covers them.
 *
 * Queries: a fixed 3 bulk SELECTs, whatever the range. No per-member query (no N+1).
 */
const ExcelJS = require('exceljs');
const {
  getEffectiveAccountState,
  countsForPairingSource,
  countsForDirectReferralSource,
  getAccountStateLabel,
} = require('./accountState');
const { summarizeQualifiedDirectLegs } = require('./binaryEligibility');
const { pairingWeekKey, isCarryFlushActive } = require('./income/pairing');
const { rateForLeadershipLevel } = require('./income/leadership');
const {
  getPackagePairingWeeklyCap,
  getPackagePairingMonthlyCap,
  getPackageSealingPoint,
  getPackagePairingDepthLimit,
} = require('./packagePolicy');
const { ACCOUNT_TYPES } = require('../utils/helpers');

const MAX_MONTHS = 24;
const EPSILON = 1e-9;
const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };

// Node-era usertab.datereg and upgradetab.transdate are stored in UTC, legacy PHP rows in Manila
// time (same split the income-release report uses). Month buckets shift Node-era rows +8h.
// The ENGINE does not shift (it buckets raw days), so the replay below uses the raw value.
const NODE_ERA_CUTOVER = '2026-06-01';

class InvalidRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRangeError';
    this.code = 'INVALID_RANGE';
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v || 0);

function parseMonth(value, label) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value ?? ''));
  if (!m) throw new InvalidRangeError(`"${label}" must be a month in YYYY-MM format.`);
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

const monthKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;

function resolveRange({ from, to } = {}) {
  if (!from || !to) throw new InvalidRangeError('Both "from" and "to" (YYYY-MM) are required.');
  const fromIdx = parseMonth(from, 'from');
  const toIdx = parseMonth(to, 'to');
  if (fromIdx > toIdx) throw new InvalidRangeError('"from" must not be after "to".');
  if (toIdx - fromIdx + 1 > MAX_MONTHS) throw new InvalidRangeError(`Range is limited to ${MAX_MONTHS} months.`);
  const months = [];
  for (let i = fromIdx; i <= toIdx; i += 1) months.push(monthKey(i));
  return { from: monthKey(fromIdx), to: monthKey(toIdx), months };
}

/** 'YYYY-MM-DD HH:MM:SS' (as stored) -> 'YYYY-MM-DD HH:MM:SS' in Manila time. */
function toManila(stored) {
  if (!stored) return null;
  const s = String(stored);
  if (s < NODE_ERA_CUTOVER) return s;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return s;
  d.setUTCHours(d.getUTCHours() + 8);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Same as pairing.js normalizeToDay (kept local so the replay never depends on a private helper). */
function engineDay(value) {
  if (!value) return null;
  const day = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} 00:00:00` : null;
}

// ---- snapshot ----------------------------------------------------------------

const SNAPSHOT_QUERIES = {
  users: `SELECT u.uid, u.refid, u.drefid, u.position, u.accttype, u.currentaccttype,
                 u.codeid, u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints, u.directreferral,
                 u.activationcode,
                 DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i:%s') AS datereg,
                 m.username
            FROM usertab u
            LEFT JOIN memberstab m ON m.uid = u.uid`,
  upgrades: `SELECT ut.id, ut.uid, ut.producttype, ut.binarypoints, ut.incentivepoints, ut.codeid,
                    DATE_FORMAT(ut.transdate, '%Y-%m-%d %H:%i:%s') AS transdate,
                    c.id AS code_row_id, c.code, c.codetype, c.productamount
               FROM upgradetab ut
               LEFT JOIN codestab c ON c.id = ut.codeid
              WHERE ut.transtype = 1
              ORDER BY ut.transdate ASC, ut.id ASC`,
  // One row per registration code string, so the report can show the code's own type
  // (a code string can exist twice in legacy data; both rows are listed, the type is joined).
  regCodes: `SELECT c.code, GROUP_CONCAT(DISTINCT c.codetype ORDER BY c.codetype) AS codetypes
               FROM codestab c
               JOIN usertab u ON u.activationcode = c.code
              GROUP BY c.code`,
  carryResets: `SELECT uid, DATE_FORMAT(carry_flush_day, '%Y-%m-%d') AS flush_day
                  FROM pairing_carry_resettab`,
};

async function loadSnapshot(db) {
  const out = {};
  for (const [name, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    try {
      const [rows] = await db.query(sql);
      out[name] = rows;
    } catch (err) {
      // Before V052 runs there are no carry resets; every other table must exist.
      if (name !== 'carryResets' || err.code !== 'ER_NO_SUCH_TABLE') throw err;
      out[name] = [];
    }
  }
  return out;
}

/**
 * Executor for getEffectiveAccountState that answers its one query (latest upgrade code) from
 * memory. Mirrors getLatestUpgradeCode: transtype 1, INNER JOIN codestab, latest transdate/id.
 */
function buildUpgradeExecutor(upgrades) {
  const latest = new Map();
  for (const up of upgrades) {
    if (up.code_row_id == null) continue; // INNER JOIN semantics
    const prev = latest.get(Number(up.uid));
    if (!prev || up.transdate > prev.transdate || (up.transdate === prev.transdate && num(up.id) > num(prev.id))) {
      latest.set(Number(up.uid), up);
    }
  }
  return {
    async query(_sql, params) {
      const up = latest.get(Number(params && params[0]));
      return [up ? [{ uid: up.uid, producttype: up.producttype, upgradecodeid: up.codeid, codetype: up.codetype, productamount: up.productamount }] : []];
    },
  };
}

async function indexSnapshot(snapshot) {
  const executor = buildUpgradeExecutor(snapshot.upgrades);
  const users = new Map();
  const children = new Map();
  for (const row of snapshot.users) {
    const uid = Number(row.uid);
    const effective = await getEffectiveAccountState(uid, row, executor);
    users.set(uid, { row, effective });
    const parent = Number(row.refid || 0);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(uid);
  }
  const upgradesByUid = new Map();
  for (const up of snapshot.upgrades) {
    const uid = Number(up.uid);
    if (!upgradesByUid.has(uid)) upgradesByUid.set(uid, []);
    upgradesByUid.get(uid).push(up);
  }
  const codeTypes = new Map(snapshot.regCodes.map((r) => [String(r.code), String(r.codetypes || '')]));
  const carryFlushDays = new Map((snapshot.carryResets || [])
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.flush_day || '')))
    .map((r) => [Number(r.uid), `${r.flush_day} 00:00:00`]));
  return { users, children, upgradesByUid, codeTypes, carryFlushDays };
}

// ---- pairing replay (mirrors pairing.js getNumLevels + totalPairingAmount) ----------------------

/**
 * Collect one owner's point entries exactly like getNumLevels, plus the direct rows the
 * eligibility gate reads (collectDirectSponsorRowsViaClosure: same legs, all depths).
 */
function collectOwnerEntries(ownerUid, capAccttype, idx) {
  const depthLimit = getPackagePairingDepthLimit(capAccttype);
  const left = [];
  const right = [];
  const directRows = [];
  const stack = [];
  for (const uid of idx.children.get(ownerUid) || []) {
    const { row } = idx.users.get(uid);
    stack.push({ uid, level: 1, side: Number(row.position) === 1 ? 'left' : 'right' });
  }
  while (stack.length) {
    const { uid, level, side } = stack.pop();
    const { row, effective } = idx.users.get(uid);
    if (Number(row.drefid || 0) === ownerUid) {
      directRows.push({ ...effective, owner_leg: side, drefid: row.drefid });
    }
    const withinDepth = depthLimit == null || level <= depthLimit;
    if (withinDepth && countsForPairingSource(effective)) {
      const target = side === 'left' ? left : right;
      target.push({ key: `reg:${uid}`, points: num(row.binarypoints), date: engineDay(row.datereg), codeid: num(effective.codeid), sortTs: String(row.datereg || '') });
      if (num(row.accttype) < num(row.currentaccttype)) {
        for (const up of idx.upgradesByUid.get(uid) || []) {
          target.push({ key: `upg:${up.id}`, points: num(up.binarypoints), date: engineDay(up.transdate), codeid: 1, sortTs: String(up.transdate || '') });
        }
      }
    }
    // getNumLevels stops descending past the depth limit, but the eligibility gate does not.
    for (const childUid of idx.children.get(uid) || []) {
      stack.push({ uid: childUid, level: level + 1, side });
    }
  }
  return { left, right, directRows };
}

/**
 * Same arithmetic as totalPairingAmount; additionally consumes the matched points from FIFO
 * queues and splits each day's credited pesos over them. `locked` = owner fails the
 * eligibility gate: the engine pays 0, the matches are still counted as blocked.
 */
function replayOwnerPairing({ left, right, capAccttype, locked, carryFlushDay = null }) {
  // Carry reset (V052): same rule as totalPairingAmount, applied only once the reset day has come.
  const flushDay = isCarryFlushActive(carryFlushDay) ? carryFlushDay : null;
  let carryFlushed = false;
  const maxPay = getPackagePairingWeeklyCap(capAccttype) || 10000;
  const monthCap = getPackagePairingMonthlyCap(capAccttype) || 0;
  const sealingPoint = getPackageSealingPoint(capAccttype);

  const byDay = new Map();
  const bucket = (day) => {
    if (!byDay.has(day)) byDay.set(day, { left: [], right: [] });
    return byDay.get(day);
  };
  // Entries without a date never pair in the engine (lp.date === date is never true for null).
  for (const e of left) if (e.date && (e.codeid === 1 || e.codeid === 3)) bucket(e.date).left.push(e);
  for (const e of right) if (e.date && (e.codeid === 1 || e.codeid === 3)) bucket(e.date).right.push(e);
  const order = (a, b) => (a.sortTs < b.sortTs ? -1 : a.sortTs > b.sortTs ? 1 : a.key.localeCompare(b.key));
  // The engine iterates every date that has a pairing-source entry on either leg; dates of
  // non-1/3 entries add nothing, so iterating only populated days is equivalent.
  const days = [...byDay.keys()].sort();

  const leftQ = [];
  const rightQ = [];
  let lq = 0;
  let rq = 0;
  let lcounter = 0;
  let rcounter = 0;
  let ttlbpay = 0;
  const weeklyCredits = new Map();
  const monthlyCredits = new Map();
  const shares = new Map(); // key -> { amount, paidMatches, blockedMatches, cappedPoints }
  const share = (key) => {
    if (!shares.has(key)) shares.set(key, { amount: 0, paidMatches: 0, blockedMatches: 0, cappedPoints: 0 });
    return shares.get(key);
  };

  for (const day of days) {
    if (flushDay && !carryFlushed && day >= flushDay) {
      // The previous owner's unmatched points leave the queues with the carry.
      lcounter = 0;
      rcounter = 0;
      lq = leftQ.length;
      rq = rightQ.length;
      carryFlushed = true;
    }
    const { left: dl, right: dr } = byDay.get(day);
    dl.sort(order);
    dr.sort(order);
    let leftToday = 0;
    let rightToday = 0;
    for (const e of dl) { leftToday += e.points; if (e.points > 0) leftQ.push({ key: e.key, remaining: e.points }); }
    for (const e of dr) { rightToday += e.points; if (e.points > 0) rightQ.push({ key: e.key, remaining: e.points }); }
    lcounter += leftToday;
    rcounter += rightToday;

    let ttlcounter;
    if (lcounter < rcounter) {
      ttlcounter = lcounter; rcounter -= lcounter; lcounter = 0;
    } else if (rcounter < lcounter) {
      ttlcounter = rcounter; lcounter -= rcounter; rcounter = 0;
    } else {
      ttlcounter = rcounter; lcounter = 0; rcounter = 0;
    }

    const monthKeyDay = String(day).slice(0, 7);
    const bpay = Number(ttlcounter || 0);
    const weekKey = pairingWeekKey(day);
    const weekRemaining = Math.max(0, maxPay - Number(weeklyCredits.get(weekKey) || 0));
    const monthRemaining = monthCap > 0 ? Math.max(0, monthCap - Number(monthlyCredits.get(monthKeyDay) || 0)) : bpay;
    const weeklyCredited = Math.min(bpay, weekRemaining, monthRemaining);
    const sealingRemaining = sealingPoint > 0 ? Math.max(0, sealingPoint - ttlbpay) : weeklyCredited;
    const engineCredit = sealingPoint > 0 ? Math.min(weeklyCredited, sealingRemaining) : weeklyCredited;
    weeklyCredits.set(weekKey, Number(weeklyCredits.get(weekKey) || 0) + engineCredit);
    if (monthCap > 0) monthlyCredits.set(monthKeyDay, Number(monthlyCredits.get(monthKeyDay) || 0) + engineCredit);
    ttlbpay += engineCredit;

    if (bpay <= 0) continue;
    const credited = locked ? 0 : engineCredit;
    const pesoPerPoint = credited / bpay;
    const touched = new Set();
    const consume = (queue, startIdx) => {
      let need = bpay;
      let i = startIdx;
      while (need > EPSILON && i < queue.length) {
        const chunk = queue[i];
        const take = Math.min(chunk.remaining, need);
        chunk.remaining -= take;
        need -= take;
        const s = share(chunk.key);
        s.amount += (take * pesoPerPoint) / 2;
        s.cappedPoints += locked ? 0 : (take * (bpay - credited)) / bpay;
        touched.add(chunk.key);
        if (chunk.remaining <= EPSILON) i += 1;
      }
      return i;
    };
    lq = consume(leftQ, lq);
    rq = consume(rightQ, rq);
    for (const key of touched) {
      if (locked) share(key).blockedMatches += 1;
      else if (credited > 0) share(key).paidMatches += 1;
    }
  }

  return { totalPay: locked ? 0 : ttlbpay, shares };
}

// ---- report -----------------------------------------------------------------

function blankCode() {
  return {
    dr: 0,
    drBeneficiaryUid: null,
    smb: 0,
    smbPaidMatches: 0,
    smbUplinesPaid: 0,
    smbBlockedMatches: 0,
    smbCappedPoints: 0,
    leadership: 0,
  };
}

/**
 * @param {{from,to}} params YYYY-MM months (Manila) of the code's encoding date
 * @param {{query}} db read-only handle
 */
async function buildIncomePerCodeReport(params, db) {
  const range = resolveRange(params);
  const snapshot = await loadSnapshot(db);
  return computeIncomePerCode(range, snapshot);
}

async function computeIncomePerCode(range, snapshot) {
  const idx = await indexSnapshot(snapshot);
  const inRange = new Set(range.months);
  const username = (uid) => (idx.users.get(Number(uid))?.row.username) || (uid ? `UID ${uid}` : '');

  // 1. Codes encoded in the range (registrations + upgrades), keyed like the replay keys.
  const codes = new Map();
  for (const [uid, { row }] of idx.users) {
    const manila = toManila(row.datereg);
    if (!manila || !inRange.has(manila.slice(0, 7))) continue;
    codes.set(`reg:${uid}`, {
      key: `reg:${uid}`,
      kind: 'Registration',
      code: row.activationcode || '',
      codeTypes: idx.codeTypes.get(String(row.activationcode || '')) || '',
      month: manila.slice(0, 7),
      encodedAt: manila,
      uid,
      packageType: num(row.accttype),
      entryType: CODE_LABEL[num(row.codeid)] || `codeid ${row.codeid}`,
      stateToday: getAccountStateLabel(idx.users.get(uid).effective),
      sponsorUid: num(row.drefid) || null,
      ...blankCode(),
    });
  }
  for (const [uid, ups] of idx.upgradesByUid) {
    for (const up of ups) {
      const manila = toManila(up.transdate);
      if (!manila || !inRange.has(manila.slice(0, 7)) || !idx.users.has(uid)) continue;
      const { row, effective } = idx.users.get(uid);
      codes.set(`upg:${up.id}`, {
        key: `upg:${up.id}`,
        kind: 'Upgrade',
        code: up.code || '',
        codeTypes: up.codetype == null ? '' : String(up.codetype),
        month: manila.slice(0, 7),
        encodedAt: manila,
        uid,
        packageType: num(up.producttype),
        entryType: CODE_LABEL[num(up.codetype)] || (up.codetype == null ? 'unknown' : `codetype ${up.codetype}`),
        stateToday: getAccountStateLabel(effective),
        sponsorUid: num(row.drefid) || null,
        ...blankCode(),
      });
    }
  }

  // 2. Direct referral by rule (getDREF eligibility = the member's effective state today).
  for (const c of codes.values()) {
    const { row, effective } = idx.users.get(c.uid);
    if (!c.sponsorUid || !idx.users.has(c.sponsorUid) || !countsForDirectReferralSource(effective)) continue;
    c.drBeneficiaryUid = c.sponsorUid;
    if (c.kind === 'Registration') c.dr = num(row.directreferral);
    else c.dr = num((idx.upgradesByUid.get(c.uid) || []).find((u) => `upg:${u.id}` === c.key)?.incentivepoints);
  }

  // 3. SMB: replay every binary upline of an in-range code, full history.
  const owners = new Set();
  for (const c of codes.values()) {
    let parent = num(idx.users.get(c.uid).row.refid);
    const seen = new Set();
    while (parent && idx.users.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      owners.add(parent);
      parent = num(idx.users.get(parent).row.refid);
    }
  }

  const check = { owners: owners.size, engineTotal: 0, attributedTotal: 0, lockedOwners: 0 };
  const ownerShares = []; // { ownerUid, key, amount } for leadership
  for (const ownerUid of owners) {
    const { effective } = idx.users.get(ownerUid);
    const capAccttype = num(effective.currentaccttype || effective.accttype);
    const { left, right, directRows } = collectOwnerEntries(ownerUid, capAccttype, idx);
    const locked = !summarizeQualifiedDirectLegs(ownerUid, directRows).canEarnPairing;
    if (locked) check.lockedOwners += 1;
    const { totalPay, shares } = replayOwnerPairing({
      left, right, capAccttype, locked, carryFlushDay: idx.carryFlushDays.get(ownerUid) || null,
    });
    check.engineTotal += totalPay;
    for (const [key, s] of shares) {
      check.attributedTotal += s.amount;
      const c = codes.get(key);
      if (!c) continue;
      c.smb += s.amount;
      c.smbPaidMatches += s.paidMatches;
      c.smbBlockedMatches += s.blockedMatches;
      c.smbCappedPoints += s.cappedPoints;
      if (s.paidMatches > 0) c.smbUplinesPaid += 1;
      if (s.amount > 0) ownerShares.push({ ownerUid, key, amount: s.amount });
    }
  }

  // 4. Leadership by rule: 5/2/1/1/1% of each SMB share, up the earner's sponsor line.
  for (const { ownerUid, key, amount } of ownerShares) {
    if (!countsForPairingSource(idx.users.get(ownerUid).row)) continue; // leadership.js reads the raw row
    let beneficiary = num(idx.users.get(ownerUid).row.drefid);
    const seen = new Set([ownerUid]);
    for (let level = 1; level <= 5 && beneficiary && idx.users.has(beneficiary) && !seen.has(beneficiary); level += 1) {
      seen.add(beneficiary);
      codes.get(key).leadership += amount * rateForLeadershipLevel(level);
      beneficiary = num(idx.users.get(beneficiary).row.drefid);
    }
  }

  const rows = [...codes.values()]
    .sort((a, b) => (a.encodedAt < b.encodedAt ? -1 : a.encodedAt > b.encodedAt ? 1 : a.key.localeCompare(b.key)))
    .map((c) => ({
      ...c,
      username: username(c.uid),
      sponsor: c.sponsorUid ? username(c.sponsorUid) : '',
      packageName: ACCOUNT_TYPES[c.packageType] || `type ${c.packageType}`,
      dr: round2(c.dr),
      smb: round2(c.smb),
      leadership: round2(c.leadership),
      smbCappedPoints: round2(c.smbCappedPoints),
      total: round2(c.dr + c.smb + c.leadership),
    }));

  check.engineTotal = round2(check.engineTotal);
  check.attributedTotal = round2(check.attributedTotal);
  check.difference = round2(check.engineTotal - check.attributedTotal);
  return { range, rows, summary: summarize(rows), check };
}

const SMB_BUCKETS = [
  ['0', (n) => n === 0],
  ['1-2', (n) => n >= 1 && n <= 2],
  ['3-4', (n) => n >= 3 && n <= 4],
  ['5+', (n) => n >= 5],
];

function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = `${r.month}|${r.kind}|${r.packageType}`;
    if (!groups.has(id)) {
      groups.set(id, {
        month: r.month, kind: r.kind, packageType: r.packageType, packageName: r.packageName,
        codes: 0, PD: 0, FS: 0, CD: 0, dr: 0, smb: 0, leadership: 0, total: 0,
        smbBuckets: Object.fromEntries(SMB_BUCKETS.map(([k]) => [k, 0])),
      });
    }
    const g = groups.get(id);
    g.codes += 1;
    if (g[r.entryType] !== undefined) g[r.entryType] += 1;
    g.dr += r.dr; g.smb += r.smb; g.leadership += r.leadership; g.total += r.total;
    const bucket = SMB_BUCKETS.find(([, test]) => test(r.smbPaidMatches));
    g.smbBuckets[bucket[0]] += 1;
  }
  return [...groups.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || a.kind.localeCompare(b.kind) || a.packageType - b.packageType)
    .map((g) => ({
      ...g,
      dr: round2(g.dr), smb: round2(g.smb), leadership: round2(g.leadership), total: round2(g.total),
      avgTotal: g.codes ? round2(g.total / g.codes) : null,
      avgSmb: g.codes ? round2(g.smb / g.codes) : null,
    }));
}

// ---- workbook ----------------------------------------------------------------

const NOTES = [
  'Figures are computed BY RULE with the same engine the wallet uses, on today\'s data. The wallet ledger does not record which code caused a credit, so these are attributions, not ledger lines.',
  'Direct Referral: the sponsor\'s DR for this code, counted only when the member is a valid DR source today (PD, or CD fully paid). FS and unpaid CD codes give 0.',
  'SMB: every binary upline\'s pairing is replayed. Each day\'s credited amount is split over the points that day\'s match used (oldest unmatched points first), half to the left code and half to the right code. So one Gold matched against one Gold = PHP 1,000 for the upline, shown as PHP 500 on each code. The shares of all codes add up to the engine total (see Check).',
  'SMB matches paid = how many times this code\'s points were part of a paid match (one per upline per day). Uplines paid = how many different uplines received SMB from it. Blocked matches = the upline had not unlocked pairing (no personally sponsored qualified direct), so the match paid 0. Capped points = matched but cut by the weekly/monthly cap.',
  'Leadership: 5/2/1/1/1% of each SMB share, paid up the SMB earner\'s sponsor line for 5 levels, when the earner is a valid leadership source.',
  'Hi-Five and Unilevel are not per code (they depend on sets of directs and monthly repurchases). See the Income Release report for them by month.',
  'SMB is current-state and lifetime-to-date: a code\'s SMB keeps growing while its uplines\' other legs grow. Re-run the report for a later snapshot.',
  'Legacy note: members earned much of their SMB under the old PHP system. For codes encoded before June 2026 the rule-based figure can differ from what was actually paid then. Actual payments are in the Income Release report (payouthistorytab).',
  'Months are Manila months of the encoding date (Node-era dates are stored in UTC and shifted +8h).',
];

function buildIncomePerCodeWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NOGATU Alliance Admin';
  wb.created = new Date();
  const money = '#,##0.00';
  const header = (ws, cols) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: { row: 1, column: cols } };
  };

  const per = wb.addWorksheet('Per Code');
  per.columns = [
    { header: 'Encoded (Manila)', key: 'encodedAt', width: 20 },
    { header: 'Kind', key: 'kind', width: 13 },
    { header: 'Code', key: 'code', width: 16 },
    { header: 'Package', key: 'packageName', width: 11 },
    { header: 'Entry Type', key: 'entryType', width: 11 },
    { header: 'Account State Today', key: 'stateToday', width: 18 },
    { header: 'Member', key: 'username', width: 18 },
    { header: 'Sponsor', key: 'sponsor', width: 18 },
    { header: 'Direct Referral (PHP)', key: 'dr', width: 20 },
    { header: 'SMB (PHP)', key: 'smb', width: 14 },
    { header: 'SMB Matches Paid', key: 'smbPaidMatches', width: 17 },
    { header: 'Uplines Paid SMB', key: 'smbUplinesPaid', width: 17 },
    { header: 'SMB Matches Blocked', key: 'smbBlockedMatches', width: 20 },
    { header: 'Capped Points', key: 'smbCappedPoints', width: 14 },
    { header: 'Leadership (PHP)', key: 'leadership', width: 17 },
    { header: 'Total (PHP)', key: 'total', width: 15 },
  ];
  for (const k of ['dr', 'smb', 'leadership', 'total', 'smbCappedPoints']) per.getColumn(k).numFmt = money;
  for (const r of report.rows) per.addRow(r);
  header(per, per.columns.length);

  const sum = wb.addWorksheet('By Package & Month');
  sum.columns = [
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Kind', key: 'kind', width: 13 },
    { header: 'Package', key: 'packageName', width: 11 },
    { header: 'Codes', key: 'codes', width: 8 },
    { header: 'PD', key: 'PD', width: 6 },
    { header: 'FS', key: 'FS', width: 6 },
    { header: 'CD', key: 'CD', width: 6 },
    { header: 'Direct Referral (PHP)', key: 'dr', width: 20 },
    { header: 'SMB (PHP)', key: 'smb', width: 14 },
    { header: 'Leadership (PHP)', key: 'leadership', width: 17 },
    { header: 'Total (PHP)', key: 'total', width: 15 },
    { header: 'Average per Code (PHP)', key: 'avgTotal', width: 22 },
    { header: 'Average SMB per Code (PHP)', key: 'avgSmb', width: 25 },
    { header: 'Codes with 0 SMB matches', key: 'b0', width: 13 },
    { header: '1-2 matches', key: 'b12', width: 12 },
    { header: '3-4 matches', key: 'b34', width: 12 },
    { header: '5+ matches', key: 'b5', width: 11 },
  ];
  for (const k of ['dr', 'smb', 'leadership', 'total', 'avgTotal', 'avgSmb']) sum.getColumn(k).numFmt = money;
  for (const g of report.summary) {
    sum.addRow({ ...g, b0: g.smbBuckets['0'], b12: g.smbBuckets['1-2'], b34: g.smbBuckets['3-4'], b5: g.smbBuckets['5+'] });
  }
  header(sum, sum.columns.length);

  const chk = wb.addWorksheet('Check');
  chk.columns = [{ header: 'Check', key: 'k', width: 60 }, { header: 'Value', key: 'v', width: 20 }];
  chk.addRow({ k: 'Range', v: `${report.range.from} to ${report.range.to}` });
  chk.addRow({ k: 'Binary uplines replayed', v: report.check.owners });
  chk.addRow({ k: 'Uplines not yet unlocked for pairing (pay 0)', v: report.check.lockedOwners });
  chk.addRow({ k: 'Engine SMB total of those uplines (PHP)', v: report.check.engineTotal });
  chk.addRow({ k: 'SMB attributed to codes, all codes (PHP)', v: report.check.attributedTotal });
  chk.addRow({ k: 'Difference (must be 0.00)', v: report.check.difference });
  header(chk, 2);

  const notes = wb.addWorksheet('Notes');
  notes.columns = [{ header: 'Notes', key: 'note', width: 140 }];
  for (const n of NOTES) notes.addRow({ note: n }).alignment = { wrapText: true, vertical: 'top' };
  header(notes, 1);
  return wb;
}

module.exports = {
  InvalidRangeError,
  resolveRange,
  toManila,
  SNAPSHOT_QUERIES,
  loadSnapshot,
  indexSnapshot,
  collectOwnerEntries,
  replayOwnerPairing,
  computeIncomePerCode,
  buildIncomePerCodeReport,
  buildIncomePerCodeWorkbook,
};
