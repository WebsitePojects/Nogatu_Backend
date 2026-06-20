/**
 * detect_bad_placements.js  (READ-ONLY)
 *
 * Finds recently-registered members whose BINARY placement is anomalous — i.e. the
 * sponsor (drefid) is NOT a binary ancestor of the member. In a correct placement the
 * recruit always lands inside the sponsor's own binary subtree (spillover included), so
 * the sponsor must be a binary ancestor. A member where that is false was placed into
 * another tree / arbitrary slot — the exact damage an editable Placement UID without the
 * network check could cause during encoding.
 *
 * No writes. Prints env=/DB= first.
 *
 * Usage:
 *   NODE_ENV=production node scripts/detect_bad_placements.js --hours 72
 *   NODE_ENV=production node scripts/detect_bad_placements.js --since 2026-06-18
 */
const { loadBackendEnv, getDbConfig } = require('./env');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${envFile} DB=${db.user}@${db.host}/${db.database}`);

  const hours = Number(arg('hours')) || 0;
  const since = arg('since'); // YYYY-MM-DD
  const where = since
    ? 'DATE(u.datereg) >= ?'
    : `u.datereg >= DATE_SUB(NOW(), INTERVAL ${hours > 0 ? hours : 72} HOUR)`;
  const params = since ? [since] : [];

  const { pool } = require('../config/database');

  const [rows] = await pool.query(
    `SELECT u.uid, u.refid, u.drefid, u.position, u.currentaccttype,
            DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i') AS datereg, m.username
       FROM usertab u LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.uid = u.mainid AND u.drefid > 0 AND u.refid > 0 AND ${where}
      ORDER BY u.datereg ASC`,
    params
  );
  console.log(`\nChecking ${rows.length} member(s) registered ${since ? `since ${since}` : `in last ${hours || 72}h`}…`);

  // sponsor must be a binary ancestor of the member: closure row (ancestor=drefid,
  // descendant=uid) — fall back to a live refid walk if the closure is stale/absent.
  async function isBinaryAncestor(ancestorUid, memberUid) {
    try {
      const [c] = await pool.query(
        'SELECT 1 FROM binary_tree_closuretab WHERE ancestor_uid = ? AND descendant_uid = ? LIMIT 1',
        [ancestorUid, memberUid]
      );
      if (c.length) return true;
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    // live walk up refid
    let cur = memberUid;
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [[p]] = await pool.query('SELECT refid FROM usertab WHERE uid = ? LIMIT 1', [cur]);
      const parent = Number(p?.refid || 0);
      if (!parent || parent === cur) return false;
      if (parent === ancestorUid) return true;
      cur = parent;
    }
    return false;
  }

  const bad = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isBinaryAncestor(Number(r.drefid), Number(r.uid));
    if (!ok) bad.push(r);
  }

  if (bad.length === 0) {
    console.log('\n✅ No anomalous placements found — every recruit is inside its sponsor\'s binary subtree.');
  } else {
    console.log(`\n🚨 ${bad.length} ANOMALOUS placement(s) — recruit NOT in sponsor's binary tree:`);
    console.log(`${'username'.padEnd(16)} ${'uid'.padStart(10)} ${'refid(binParent)'.padStart(16)} ${'drefid(sponsor)'.padStart(16)} pos  registered`);
    for (const r of bad) {
      console.log(`${String(r.username || r.uid).padEnd(16)} ${String(r.uid).padStart(10)} ${String(r.refid).padStart(16)} ${String(r.drefid).padStart(16)} ${r.position === 1 ? 'L' : 'R'}    ${r.datereg}`);
    }
    console.log('\nThese were placed outside the encoder/sponsor network. Review before re-parenting.');
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
