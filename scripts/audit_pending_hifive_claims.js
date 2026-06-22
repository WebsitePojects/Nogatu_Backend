/**
 * READ-ONLY — pending Hi-Five PACKAGE claim forfeit-safety check.
 *
 * Hi-Five package cash is now AUTO-CREDITED on the monotonic ttlincome5 basis, and manual
 * claim submission is disabled. Any leftover 'pending_review' package claim is stale. This
 * proves, per member, that the claim is SAFE TO FORFEIT — i.e. the member's full Hi-Five
 * package entitlement is already covered by ttlincome5, so approving it would credit ₱0
 * (approvePackageClaim is monotonic: min(payout, max(0, entitlement - ttlincome5))).
 *
 *   entitlement = Σ over packages (qualifiedSets × packageReward)   [from buildHiFiveStatus]
 *   alreadyPaid = payouttotaltab.ttlincome5
 *   owed        = max(0, entitlement − alreadyPaid)
 *   owed == 0  -> SAFE TO FORFEIT (already paid)   |   owed > 0 -> genuinely owed, do NOT forfeit
 *
 * Reports only. No writes. Usage:
 *   GREEN: node scripts/audit_pending_hifive_claims.js [username ...]
 *   BLUE:  NODE_ENV=production node scripts/audit_pending_hifive_claims.js [username ...]
 * Defaults to the reported stale claimants when no args are given.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const DEFAULT_NAMES = ['Nanette', 'Reymorato01'];

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[audit_pending_hifive_claims] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}\n`);

  const { pool } = require('../config/database');
  const { buildHiFiveStatus } = require('../services/income/hifiveBonus');

  // All pending package claims (the stale population).
  const [pending] = await pool.query(
    `SELECT q.qualification_uid, q.member_uid, q.package_or_product, q.qualifying_count,
            q.status, DATE_FORMAT(q.created_at,'%Y-%m-%d %H:%i') AS created_at,
            m.username
       FROM hifive_qualificationstab q
       LEFT JOIN memberstab m ON m.uid = q.member_uid
      WHERE q.hifive_type = 'package' AND q.status = 'pending_review'
      ORDER BY q.member_uid, q.qualification_uid`
  ).catch((e) => { console.log('hifive_qualificationstab read failed:', e.code || e.message); return [[]]; });

  // Resolve any explicitly-named members too (even if they have no pending row).
  const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NAMES;
  const namedUids = new Map();
  for (const n of names) {
    const [r] = await pool.query('SELECT uid, username FROM memberstab WHERE username = ? LIMIT 1', [n]);
    if (r.length) namedUids.set(Number(r[0].uid), r[0].username); else console.log(`(named) ${n}: not found in this DB`);
  }

  const targetUids = new Set([...pending.map((p) => Number(p.member_uid)), ...namedUids.keys()]);
  if (!targetUids.size) { console.log('No pending package claims and no named members resolved.'); await pool.end().catch(()=>{}); return; }

  console.log(`pending package claims: ${pending.length} · members to evaluate: ${targetUids.size}\n`);

  for (const uid of targetUids) {
    const status = await buildHiFiveStatus(uid).catch((e) => ({ _err: e.message }));
    if (status._err) { console.log(`uid ${uid}: buildHiFiveStatus error: ${status._err}`); continue; }
    const entitlement = (status.packageBonus?.packages || []).reduce(
      (s, p) => s + Number(p.qualifiedSets || 0) * Number(p.rewardAmount || 0), 0
    );
    const [[pt]] = await pool.query('SELECT ttlincome5 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid]);
    const paid = Number(pt?.ttlincome5 || 0);
    const owed = Math.max(0, entitlement - paid);
    const claims = pending.filter((p) => Number(p.member_uid) === uid);
    const uname = namedUids.get(uid) || claims[0]?.username || `uid ${uid}`;

    console.log(`${uname} (uid ${uid})`);
    for (const c of claims) {
      console.log(`   pending claim #${c.qualification_uid}: pkg=${c.package_or_product} qty=${c.qualifying_count} created=${c.created_at}`);
    }
    if (!claims.length) console.log('   (no pending package claim row)');
    console.log(`   entitlement(Σ qualifiedSets×reward)=₱${entitlement.toLocaleString()}  ttlincome5 paid=₱${paid.toLocaleString()}  owed=₱${owed.toLocaleString()}`);
    console.log(`   -> ${owed <= 0 ? '✅ SAFE TO FORFEIT (entitlement already covered by ttlincome5; approve would credit ₱0)'
                                   : `⚠ GENUINELY OWED ₱${owed.toLocaleString()} — do NOT forfeit; the auto-credit will pay it`}\n`);
  }

  console.log('Done (read-only).');
  await pool.end().catch(() => {});
}

main().catch((err) => { console.error('[audit_pending_hifive_claims] ERROR:', err); process.exit(1); });
