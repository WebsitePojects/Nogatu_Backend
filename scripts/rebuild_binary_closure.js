#!/usr/bin/env node
/**
 * Rebuild binary_tree_closuretab to the FULL tree depth.
 *
 * ── Root cause ──────────────────────────────────────────────────────────────
 * migrations/V008__backfill_binary_tree_closure_paths.sql deepens the closure
 * with a FIXED number of INSERT IGNORE passes (10). Each pass only extends the
 * closure by ONE level, so any descendant deeper than ~level 11 below an
 * ancestor was never inserted. On spillover binary trees (which get deep), this
 * silently drops most deep descendants.
 *
 * Consequence (confirmed for Elmer, uid 6122895 on staging):
 *   real binary descendants (refid walk) = 2105
 *   binary_tree_closuretab descendants   =  253   <-- starved
 * Every closure consumer is affected: the pairing trace
 * (services/income/pairingTracker.js) could only reconstruct 55 PV of his real
 * 1,592 PV (= ₱398,000) lifetime SMB; ranking / network / placement undercount
 * too.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 * Re-seeds the self + direct-child rows, then runs the SAME idempotent
 * INSERT IGNORE deepening pass one level at a time until it converges (a level
 * yields 0 new rows = the real bottom of the tree). Registration already
 * maintains the closure correctly going forward (services/registration.js:588),
 * so once the historical backlog is filled it stays correct.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * INSERT IGNORE only ADDS missing (ancestor, descendant) pairs. It never
 * UPDATEs or DELETEs an existing row, and it never touches any money / payout
 * table. Re-runnable; converges to the same state. Read-mostly elsewhere.
 *
 *   node scripts/rebuild_binary_closure.js
 */

const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const MAX_DEPTH = 500; // hard safety stop against any refid cycle / runaway

async function main() {
  const envFile = loadBackendEnv();
  const dbConfig = getDbConfig();
  // env discipline (CLAUDE.md): announce the exact DB target BEFORE any work.
  console.log(
    `[rebuild_binary_closure] env=${envFile} DB=${dbConfig.user}@${dbConfig.host}/${dbConfig.database}`
  );

  const conn = await mysql.createConnection({ ...dbConfig, multipleStatements: false });
  try {
    const [[before]] = await conn.query('SELECT COUNT(*) AS n FROM binary_tree_closuretab');
    console.log(`[start] closure rows before = ${before.n}`);

    // 1) self rows (depth 0) for every member — idempotent.
    const [selfRes] = await conn.query(
      `INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
       SELECT uid, uid, 0, 'self' FROM usertab`
    );
    console.log(`[seed] self rows added: ${selfRes.affectedRows}`);

    // 2) direct children (depth 1), leg = the child's own binary position.
    const [directRes] = await conn.query(
      `INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
       SELECT u.refid, u.uid, 1,
              CASE WHEN u.position = 1 THEN 'left' ELSE 'right' END
       FROM usertab u
       WHERE u.refid IS NOT NULL AND u.refid > 0 AND u.refid <> u.uid`
    );
    console.log(`[seed] direct-child rows added: ${directRes.affectedRows}`);

    // 3) deepen via repeated FULL transitive-closure passes until convergence.
    //    Each pass extends every non-self row by one level: if (A,X,d) exists and
    //    X -> Y (refid), add (A,Y,d+1). INSERT IGNORE skips the rows already
    //    present, so a pass only materialises the next missing layer everywhere
    //    (middle gaps from broken chains AND deep tails are both repaired,
    //    top-down). We loop until a pass adds 0 rows = the closure is complete.
    //    (V008's bug was running a FIXED 10 passes instead of looping to 0.)
    //    The self-join reads a consistent snapshot per statement, so each pass
    //    adds exactly one layer — classic semi-naive closure, guaranteed to
    //    converge in (max tree depth) passes.
    let pass = 0;
    let added = 0;
    let totalDeepened = 0;
    do {
      const [res] = await conn.query(
        `INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
         SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
         FROM binary_tree_closuretab c
         INNER JOIN usertab child
                 ON child.refid = c.descendant_uid
                AND child.uid <> c.descendant_uid
         WHERE c.leg <> 'self' AND c.depth < ?`,
        [MAX_DEPTH]
      );
      added = res.affectedRows;
      totalDeepened += added;
      pass += 1;
      console.log(`[deepen] pass ${pass}: +${added} rows`);
    } while (added > 0 && pass < MAX_DEPTH);

    if (pass >= MAX_DEPTH) {
      console.warn(`[warn] hit MAX_DEPTH=${MAX_DEPTH} passes without converging — inspect for a refid cycle.`);
    }

    const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM binary_tree_closuretab');
    console.log(`[done] closure rows after = ${after.n} (+${after.n - before.n}); +${totalDeepened} deepened over ${pass} passes`);

    // 4) verification probe — Elmer (uid 6122895) should now resolve ~2105.
    const [[chk]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM binary_tree_closuretab WHERE ancestor_uid = 6122895 AND depth > 0) AS closure_descendants,
         (SELECT MAX(depth)  FROM binary_tree_closuretab WHERE ancestor_uid = 6122895) AS max_depth`
    );
    console.log(`[verify] Elmer(6122895) closure_descendants=${chk.closure_descendants} max_depth=${chk.max_depth} (expected ~2105)`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[rebuild_binary_closure] FAILED:', err);
  process.exit(1);
});
