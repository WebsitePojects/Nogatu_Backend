/**
 * ONE-OFF CORRECTION — Hi-Five package sets lost when directs upgraded (Upgrade Stranding Audit,
 * 25 September 2026). Approved by management:
 *   1) Pay only PHP 15,000.00, to exactly the 3 members in Section 5 of the report.
 *   2) Pay nothing to the 13 members in Addendum A (their PHP 35,000.00 was exposure, not debt).
 *
 * How it works:
 *   - For each of the 16 pinned members, replays their directs to rebuild the per-tier high-water
 *     and checks it against the figures management signed off: earned, already paid, and due.
 *     ANY difference refuses the whole run. Members' data may have moved since 25 September; a
 *     changed figure needs a fresh sign-off, not a guess.
 *   - --commit seeds those high-water rows (hifive_package_highwatertab, V050) in one transaction,
 *     then lets the normal engine pay: autoCreditEligibleHiFivePackages() credits
 *     max(0, entitlement - ttlincome5) under a row lock, writing payouthistorytab + payouttotaltab
 *     exactly as every other Hi-Five credit. Nothing here writes a balance directly.
 *   - For the 13, the seed makes entitlement equal what they were already paid, so they are owed
 *     PHP 0 now and their next genuine set is no longer absorbed.
 *
 * Re-running is safe: once a member's ttlincome5 equals the approved earned figure the member is
 * reported as already corrected and skipped.
 *
 *   NODE_ENV=production node scripts/correct_hifive_upgrade_stranding_20260925.js            # dry run
 *   NODE_ENV=production node scripts/correct_hifive_upgrade_stranding_20260925.js --commit
 * (On green: no NODE_ENV prefix. Every line-1 header names the database.)
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const {
  getDirectReferralPackageCounts,
  getPackageRewardAmounts,
  getPackageHighWater,
  recordPackageHighWater,
  packageEntitlement,
  autoCreditEligibleHiFivePackages,
} = require('../services/income/hifiveBonus');
const { TIERS, loadEligibleDirects, loadUpgradesByUid, replayTimeline } = require('../services/income/hifiveHighWaterReplay');

const COMMIT = process.argv.includes('--commit');
const SOURCE = 'stranding-correction-20260925';
const APPROVED_TOTAL_DUE = 15000;

// Pinned from the signed-off report: Section 5 (due) and Addendum A (due 0). Pesos.
const APPROVED = [
  { uid: 2714558, username: 'antonioA1', earned: 55000, paid: 45000, due: 10000 },
  { uid: 2449222, username: 'Reming001', earned: 20000, paid: 17500, due: 2500 },
  { uid: 8778435, username: 'Nida01', earned: 22500, paid: 20000, due: 2500 },
  { uid: 42087, username: 'GoldenEagles', earned: 22500, paid: 22500, due: 0 },
  { uid: 364786, username: 'SUSING55', earned: 2500, paid: 2500, due: 0 },
  { uid: 455553, username: 'Vision01', earned: 7500, paid: 7500, due: 0 },
  { uid: 641483, username: 'POGI2026', earned: 2500, paid: 2500, due: 0 },
  { uid: 5643097, username: 'Joseph001', earned: 2500, paid: 2500, due: 0 },
  { uid: 6301181, username: 'Rosalindatop001', earned: 2500, paid: 2500, due: 0 },
  { uid: 6550334, username: 'RPCepida46', earned: 2500, paid: 2500, due: 0 },
  { uid: 7109788, username: 'Barsilisa001', earned: 5000, paid: 5000, due: 0 },
  { uid: 7453779, username: 'Reymorato01', earned: 7500, paid: 7500, due: 0 },
  { uid: 8131298, username: 'IdaSEnomis', earned: 5000, paid: 5000, due: 0 },
  { uid: 8238970, username: 'Felixocampo', earned: 2500, paid: 2500, due: 0 },
  { uid: 8742962, username: 'CORAZONABAINZA', earned: 2500, paid: 2500, due: 0 },
  { uid: 9799981, username: 'ArgeM01', earned: 2500, paid: 2500, due: 0 },
];

const peso = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });

async function walletOf(uid) {
  const [[row]] = await pool.query(
    'SELECT COALESCE(ttlincome5,0) paid, COALESCE(ttlcashbalance,0) bal FROM payouttotaltab WHERE uid = ?',
    [uid]
  );
  return { paid: Number(row?.paid || 0), bal: Number(row?.bal || 0) };
}

/** Everything the run needs for one member, plus the reasons it must not proceed. */
async function examine(member, rewards, upgradesByUid) {
  const problems = [];
  const [[who]] = await pool.query('SELECT username FROM memberstab WHERE uid = ?', [member.uid]);
  if (!who || who.username !== member.username) {
    problems.push(`uid ${member.uid} is "${who ? who.username : 'missing'}", expected "${member.username}"`);
  }

  const eligible = await loadEligibleDirects(pool, member.uid);
  const { highWater: replayed } = replayTimeline(eligible, upgradesByUid);
  const { counts } = await getDirectReferralPackageCounts(member.uid);
  const stored = await getPackageHighWater(member.uid);
  const seed = Object.fromEntries(TIERS.map((t) => [t.key, Math.max(replayed[t.key], stored[t.key])]));

  // Entitlement exactly as the engine will compute it once the seed is in place.
  const earned = packageEntitlement(counts, seed, rewards);
  const wallet = await walletOf(member.uid);
  // Only a member who was owed money can already be corrected; for the 13 paid == earned always.
  const alreadyCorrected = member.due > 0 && wallet.paid === member.earned && earned === member.earned;

  if (earned !== member.earned) problems.push(`earned ${peso(earned)} != approved ${peso(member.earned)}`);
  if (!alreadyCorrected && wallet.paid !== member.paid) {
    problems.push(`paid ${peso(wallet.paid)} != approved ${peso(member.paid)}`);
  }
  const due = Math.max(0, earned - wallet.paid);
  if (!alreadyCorrected && due !== member.due) problems.push(`due ${peso(due)} != approved ${peso(member.due)}`);

  return { member, seed, earned, wallet, due, alreadyCorrected, problems };
}

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}  mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);

  const plannedDue = APPROVED.reduce((s, m) => s + m.due, 0);
  if (plannedDue !== APPROVED_TOTAL_DUE || APPROVED.filter((m) => m.due > 0).length !== 3) {
    throw new Error('Pinned list does not match the approval (3 members, PHP 15,000.00).');
  }

  const rewards = await getPackageRewardAmounts();
  const directs = [];
  for (const m of APPROVED) {
    const [rows] = await pool.query('SELECT uid FROM usertab WHERE drefid = ?', [m.uid]);
    directs.push(...rows.map((r) => Number(r.uid)));
  }
  const upgradesByUid = await loadUpgradesByUid(pool, directs);

  const results = [];
  for (const m of APPROVED) results.push(await examine(m, rewards, upgradesByUid));

  console.log('\nmember            uid       earned        paid          due      status');
  for (const r of results) {
    const status = r.problems.length ? `REFUSED: ${r.problems.join('; ')}`
      : r.alreadyCorrected ? 'already corrected' : (r.due > 0 ? 'will be paid' : 'seed only, PHP 0');
    console.log(`${r.member.username.padEnd(17)} ${String(r.member.uid).padEnd(9)} ${peso(r.earned).padStart(12)} ${peso(r.wallet.paid).padStart(12)} ${peso(r.due).padStart(10)}   ${status}`);
  }

  const refused = results.filter((r) => r.problems.length);
  const toPay = results.filter((r) => !r.problems.length && !r.alreadyCorrected && r.due > 0);
  const payTotal = toPay.reduce((s, r) => s + r.due, 0);
  console.log(`\nto pay now: ${toPay.length} member(s), PHP ${peso(payTotal)}   refused: ${refused.length}`);

  if (refused.length) {
    console.log('\nNOTHING WRITTEN. A figure differs from the approval; it needs a fresh sign-off.');
    process.exitCode = 1;
    return;
  }
  if (!COMMIT) {
    console.log('\nDRY-RUN: nothing written. Re-run with --commit.');
    return;
  }

  // 1. Seed every approved member's high-water in one transaction.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of results) {
      await recordPackageHighWater(r.member.uid, r.seed, { db: conn, source: SOURCE });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  console.log(`\nhigh-water seeded for ${results.length} member(s), source=${SOURCE}`);

  // 2. Pay through the engine, then prove each member's before/after.
  let failures = 0;
  for (const r of results) {
    const before = await walletOf(r.member.uid);
    const out = await autoCreditEligibleHiFivePackages(r.member.uid);
    const after = await walletOf(r.member.uid);
    // A member page load can pay the same delta first; the end state is what must be right.
    const ok = after.paid === r.member.earned && after.paid - before.paid <= r.member.due;
    if (!ok) failures += 1;
    console.log(`${r.member.username.padEnd(17)} ttlincome5 ${peso(before.paid)} -> ${peso(after.paid)}`
      + `   cash ${peso(before.bal)} -> ${peso(after.bal)}   credited ${peso(out.credited)}   ${ok ? 'OK' : 'CHECK'}`);
    if (r.member.due > 0) {
      const [[row]] = await pool.query(
        'SELECT pid, income5, transdate, processid FROM payouthistorytab WHERE uid = ? AND income5 > 0 ORDER BY pid DESC LIMIT 1',
        [r.member.uid]
      );
      if (row) console.log(`${''.padEnd(17)} payouthistorytab pid ${row.pid}  income5 ${peso(row.income5)}  ${row.processid}`);
    }
  }

  // Measured from the wallets, not from the pinned list, so a mismatch cannot hide.
  let paidTotal = 0;
  for (const r of results) paidTotal += (await walletOf(r.member.uid)).paid - r.member.paid;
  if (paidTotal !== APPROVED_TOTAL_DUE) failures += 1;
  console.log(`\nCOMMITTED. Paid across all ${APPROVED.length} members: PHP ${peso(paidTotal)} (approved PHP ${peso(APPROVED_TOTAL_DUE)}); ${failures ? 'CHECK REQUIRED' : 'matches the approval'}.`);
  if (failures) process.exitCode = 1;
})()
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
