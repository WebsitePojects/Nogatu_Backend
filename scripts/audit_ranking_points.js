/**
 * READ-ONLY ranking-points audit for specific members.
 *
 * Purpose: diagnose "my ranking points are not increasing" reports (e.g. the
 * jina / ashanti / primavesa "inherited upgrade" complaint). It NEVER writes — it
 * only reads and compares three independent figures per member so the gap, if any,
 * is localized rather than guessed:
 *
 *   expected_gross  = Σ repurchasetab.incentivepoints1 over the member's DOWNLINE
 *                     (sponsor/drefid descendants, EXCLUDING the member's own
 *                     repurchases — confirmed rule 2026-06-16: you cannot contribute
 *                     to your OWN computed repurchase points).
 *   shadow_gross    = member_rank_pointstab.gross_points (the incremental aggregate
 *                     maintained by applyRepurchaseDelta on each repurchase).
 *   engine_basis    = rankingstab.basis_points / remaining_rankable_points (what the
 *                     rank engine actually used to award/deny ranks).
 *
 * Interpreting the verdict:
 *   expected > shadow            -> propagation MISSED events (async shadow failed or
 *                                   was never run). The realtime feature + a one-time
 *                                   rankPoints.backfillAll() closes it. NOT a money loss.
 *   shadow == expected, engine<  -> the rank SNAPSHOT is stale; needs a rebuild for
 *                                   that member (refreshMemberRankSnapshot / rebuild).
 *   drefid chain BROKEN          -> downline points cannot roll up at all; data fix
 *                                   needed on the sponsor link (report, do not auto-fix).
 *
 * Usage (BLUE / prod, read-only):
 *   NODE_ENV=production node scripts/audit_ranking_points.js primavesa ashanti jina
 * Args may be exact usernames or name fragments (matched against username + full name).
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const DEFAULT_TARGETS = ['primavesa', 'ashanti', 'jina'];
const MAX_DEPTH = 60;

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function resolveMembers(conn, term) {
  // Exact username first, then a fragment match on username / full name.
  const [exact] = await conn.query(
    `SELECT u.uid, u.drefid, u.currentaccttype, m.username, m.firstname, m.lastname
       FROM usertab u JOIN memberstab m ON m.uid = u.uid
      WHERE m.username = ? LIMIT 5`,
    [term]
  );
  if (exact.length) return exact;
  const like = `%${term}%`;
  const [fuzzy] = await conn.query(
    `SELECT u.uid, u.drefid, u.currentaccttype, m.username, m.firstname, m.lastname
       FROM usertab u JOIN memberstab m ON m.uid = u.uid
      WHERE m.username LIKE ? OR CONCAT_WS(' ', m.firstname, m.lastname) LIKE ?
      ORDER BY m.username LIMIT 5`,
    [like, like]
  );
  return fuzzy;
}

async function ancestorChain(conn, uid) {
  const [rows] = await conn.query(
    `WITH RECURSIVE up AS (
       SELECT uid, drefid, 0 AS d FROM usertab WHERE uid = ?
       UNION ALL
       SELECT p.uid, p.drefid, u.d + 1
         FROM up u JOIN usertab p ON p.uid = u.drefid AND p.uid <> u.uid
        WHERE u.d < ?
     )
     SELECT uid, d FROM up WHERE d > 0 ORDER BY d ASC`,
    [uid, MAX_DEPTH]
  );
  return rows.map((r) => ({ uid: num(r.uid), depth: num(r.d) }));
}

async function descendantUids(conn, uid) {
  const [rows] = await conn.query(
    `WITH RECURSIVE down AS (
       SELECT uid, drefid, 0 AS d FROM usertab WHERE uid = ?
       UNION ALL
       SELECT c.uid, c.drefid, d.d + 1
         FROM down d JOIN usertab c ON c.drefid = d.uid AND c.uid <> d.uid
        WHERE d.d < ?
     )
     SELECT uid FROM down WHERE d > 0`,
    [uid, MAX_DEPTH]
  );
  return rows.map((r) => num(r.uid)).filter((x) => x > 0);
}

async function sumRepurchasePoints(conn, uids) {
  if (!uids.length) return { rows: 0, points: 0 };
  // Chunk the IN list defensively for very wide subtrees.
  let rows = 0;
  let points = 0;
  const CHUNK = 1000;
  for (let i = 0; i < uids.length; i += CHUNK) {
    const slice = uids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    // eslint-disable-next-line no-await-in-loop
    const [[agg]] = await conn.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(incentivepoints1), 0) AS points
         FROM repurchasetab WHERE uid IN (${ph})`,
      slice
    );
    rows += num(agg.cnt);
    points += num(agg.points);
  }
  return { rows, points };
}

async function auditOne(conn, member) {
  const uid = num(member.uid);
  const label = `${member.username} (uid ${uid}, ${member.firstname || ''} ${member.lastname || ''})`.trim();
  console.log(`\n===== ${label} =====`);

  // 1. Sponsor chain integrity (up).
  const drefid = num(member.drefid);
  let chainNote = 'root (no sponsor)';
  if (drefid > 0) {
    const [[parent]] = await conn.query('SELECT uid FROM usertab WHERE uid = ? LIMIT 1', [drefid]);
    chainNote = parent ? `sponsor uid ${drefid} OK` : `BROKEN: drefid ${drefid} has NO usertab row`;
    if (drefid === uid) chainNote = `BROKEN: drefid points to self (${uid})`;
  }
  const ancestors = await ancestorChain(conn, uid);
  console.log(`  sponsor link : ${chainNote}`);
  console.log(`  uplines (drefid chain): ${ancestors.length} levels${ancestors.length ? ` (nearest uid ${ancestors[0].uid})` : ''}`);

  // 2. Own repurchases (informational — EXCLUDED from own gross).
  const [[own]] = await conn.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(incentivepoints1),0) AS points FROM repurchasetab WHERE uid = ?`,
    [uid]
  );
  console.log(`  own repurchases: ${num(own.cnt)} rows, ${num(own.points)} pts (excluded from own ranking — rolls to uplines)`);

  // 3. Expected gross = downline repurchase points that should roll UP to this member.
  const descUids = await descendantUids(conn, uid);
  const downline = await sumRepurchasePoints(conn, descUids);
  const expectedGross = downline.points;
  console.log(`  downline       : ${descUids.length} members, ${downline.rows} repurchase rows`);
  console.log(`  EXPECTED gross (Σ downline incentivepoints1): ${expectedGross}`);

  // 4. Shadow aggregate.
  const [shadowRows] = await conn.query(
    `SELECT gross_points, consumed_points, remaining_points FROM member_rank_pointstab WHERE member_uid = ? LIMIT 1`,
    [uid]
  );
  const shadow = shadowRows[0] || null;
  const shadowGross = shadow ? num(shadow.gross_points) : 0;
  console.log(`  SHADOW gross/consumed/remaining: ${shadow ? `${shadowGross} / ${num(shadow.consumed_points)} / ${num(shadow.remaining_points)}` : 'NO ROW (never propagated)'}`);

  // 5. Engine snapshot.
  const [engineRows] = await conn.query(`SELECT * FROM rankingstab WHERE uid = ? LIMIT 1`, [uid]);
  const engine = engineRows[0] || null;
  if (engine) {
    const rank = num(engine.highest_rank_no ?? engine.current_rank ?? engine.rank_level);
    console.log(`  ENGINE rank=${rank} basis=${num(engine.basis_points)} consumed=${num(engine.consumed_points)} remaining=${num(engine.remaining_rankable_points)}`);
  } else {
    console.log('  ENGINE: NO rankingstab row');
  }

  // 6. Verdict.
  const verdicts = [];
  if (chainNote.startsWith('BROKEN')) verdicts.push('SPONSOR LINK BROKEN — downline points cannot roll up; data fix needed (report only).');
  const drift = expectedGross - shadowGross;
  if (Math.abs(drift) > 0.5) {
    verdicts.push(drift > 0
      ? `SHADOW UNDER expected by ${drift} pts — propagation missed events; backfillAll()/realtime feature closes it (no money loss).`
      : `SHADOW OVER expected by ${-drift} pts — investigate double-propagation BEFORE trusting.`);
  } else {
    verdicts.push('shadow matches expected downline rollup ✓');
  }
  if (engine && shadow && Math.abs(num(engine.basis_points) - shadowGross) > 0.5) {
    verdicts.push(`engine basis (${num(engine.basis_points)}) != shadow gross (${shadowGross}) — rank snapshot likely stale; rebuild that member.`);
  }
  console.log(`  VERDICT: ${verdicts.join(' | ')}`);
}

async function main() {
  const envFile = loadBackendEnv();
  const config = getDbConfig();
  console.log(`[ranking:audit] env=${envFile} DB=${config.user}@${config.host}/${config.database}  (READ-ONLY)`);

  const terms = process.argv.slice(2).filter(Boolean);
  const targets = terms.length ? terms : DEFAULT_TARGETS;

  const conn = await mysql.createConnection(config);
  try {
    for (const term of targets) {
      // eslint-disable-next-line no-await-in-loop
      const matches = await resolveMembers(conn, term);
      if (!matches.length) {
        console.log(`\n===== "${term}" =====\n  NOT FOUND (no username/full-name match).`);
        continue;
      }
      if (matches.length > 1) {
        console.log(`\n[note] "${term}" matched ${matches.length} members — auditing all: ${matches.map((m) => m.username).join(', ')}`);
      }
      for (const member of matches) {
        // eslint-disable-next-line no-await-in-loop
        await auditOne(conn, member);
      }
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[ranking:audit] FAILED:', err.message);
  process.exit(1);
});
