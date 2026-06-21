/**
 * READ-ONLY AUDIT: total money that Hi-Five package AUTO-CREDIT would move when activated.
 *
 * Two buckets:
 *   A. Un-submitted qualified sets  — members who already qualify (>=5 qualifying direct
 *      referrals per package) but never submitted a claim. Auto-credit posts these on the
 *      member's next wallet/dashboard load. Source: buildHiFiveStatus().packageBonus
 *      (availableClaims * rewardAmount).
 *   B. Existing pending_review claims — submitted, awaiting admin approval. Counted in
 *      claimedSets so NOT in bucket A; these get credited by approving them. Source:
 *      hifive_qualificationstab status='pending_review'.
 *
 * Grand total = A + B = the full exposure to review BEFORE deploying auto-credit.
 *
 * Usage:  NODE_ENV=production node scripts/audit_hifive_autocredit_exposure.js [--limit=N] [--csv]
 * READ-ONLY. No INSERT/UPDATE/DELETE. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

function parseArgs() {
  const opt = { limit: 0, csv: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--csv') opt.csv = true;
    else if (a.startsWith('--limit=')) opt.limit = Number(a.split('=')[1]) || 0;
  }
  return opt;
}

async function main() {
  const opt = parseArgs();
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_hifive_autocredit_exposure] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);

  const { pool } = require('../config/database');
  const { buildHiFiveStatus } = require('../services/income/hifiveBonus');

  // Candidate sponsors: anyone who directly sponsors >= 5 members could have a qualified set.
  const [cands] = await pool.query(
    `SELECT u.drefid AS uid, m.username, COUNT(*) AS directs
       FROM usertab u
       JOIN memberstab m ON m.uid = u.drefid
      WHERE u.drefid > 0
      GROUP BY u.drefid
     HAVING directs >= 5
      ORDER BY directs DESC` + (opt.limit ? ` LIMIT ${opt.limit}` : '')
  );
  console.log(`candidate sponsors (>=5 directs): ${cands.length}\n`);

  // ── Bucket A: un-submitted qualified sets (auto-credit-on-load) ──
  const bucketA = [];
  let totalA = 0;
  let scanned = 0;
  for (const c of cands) {
    scanned += 1;
    // eslint-disable-next-line no-await-in-loop
    const status = await buildHiFiveStatus(Number(c.uid)).catch(() => null);
    const pkg = status?.packageBonus;
    if (!pkg) continue;
    const amt = Number(pkg.totalAvailableCashAmount || 0);
    if (amt >= 1) {
      const detail = (pkg.packages || []).filter((p) => Number(p.availableClaims) > 0)
        .map((p) => `${p.name}:${p.availableClaims}x${p.rewardAmount}`).join(' ');
      bucketA.push({ uid: c.uid, username: c.username, amt, detail });
      totalA += amt;
    }
    if (scanned % 50 === 0) process.stdout.write(`  …${scanned}/${cands.length}\r`);
  }
  bucketA.sort((a, b) => b.amt - a.amt);

  // ── Bucket B: existing pending_review package claims ──
  const [pend] = await pool.query(
    `SELECT hq.member_uid AS uid, m.username, hq.package_or_product AS pkg, COUNT(*) AS sets
       FROM hifive_qualificationstab hq
       LEFT JOIN memberstab m ON m.uid = hq.member_uid
      WHERE hq.hifive_type = 'package' AND hq.status = 'pending_review'
      GROUP BY hq.member_uid, hq.package_or_product`
  ).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });

  // reward amounts per package key
  const { getPackageRewardAmounts } = require('../services/income/hifiveBonus');
  const reward = await getPackageRewardAmounts().catch(() => ({}));
  const bucketB = [];
  let totalB = 0;
  for (const r of pend) {
    const amt = Number(reward[String(r.pkg).toLowerCase()] || 0) * Number(r.sets || 0);
    if (amt >= 1) { bucketB.push({ uid: r.uid, username: r.username, pkg: r.pkg, sets: r.sets, amt }); totalB += amt; }
  }
  bucketB.sort((a, b) => b.amt - a.amt);

  const fmt = (n) => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });

  console.log(`\n========== HI-FIVE AUTO-CREDIT EXPOSURE (read-only) ==========`);
  console.log(`A. un-submitted qualified sets (auto-credit on wallet load): members=${bucketA.length}  total=${fmt(totalA)}`);
  console.log(`B. existing pending_review claims (credit by approving):     rows=${bucketB.length}  total=${fmt(totalB)}`);
  console.log(`GRAND TOTAL hi-five that would be credited:                  ${fmt(totalA + totalB)}\n`);

  console.log(`--- top A (un-submitted qualified) ---`);
  for (const a of bucketA.slice(0, 30)) {
    console.log(`  uid=${String(a.uid).padEnd(9)} @${String(a.username).slice(0, 16).padEnd(16)} ${fmt(a.amt).padStart(12)}  ${a.detail}`);
  }
  if (bucketB.length) {
    console.log(`\n--- top B (pending_review claims) ---`);
    for (const b of bucketB.slice(0, 30)) {
      console.log(`  uid=${String(b.uid).padEnd(9)} @${String(b.username).slice(0, 16).padEnd(16)} ${String(b.pkg).padEnd(9)} ${b.sets} set(s)  ${fmt(b.amt)}`);
    }
  }

  if (opt.csv) {
    console.log('\n--- CSV A (uid,username,amount,detail) ---');
    for (const a of bucketA) console.log(`A,${a.uid},${a.username},${a.amt},"${a.detail}"`);
    console.log('--- CSV B (uid,username,package,sets,amount) ---');
    for (const b of bucketB) console.log(`B,${b.uid},${b.username},${b.pkg},${b.sets},${b.amt}`);
  }

  console.log(`\nNOTE: read-only — nothing written. Review this total before deploying auto-credit.`);
  console.log(`Bucket A posts on member wallet/dashboard load once auto-credit is live; bucket B`);
  console.log(`is credited by approving those pending claims. Idempotent: each set credits once.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
