const { pool } = require('../config/database');
const { createProcessKey, createPublicId } = require('../utils/security');
const { rebuildRankSnapshot } = require('./ranking');
const { applyRepurchaseDelta } = require('./rankPoints');

const RANKING_LOCK_NAME = 'ranking_race_global_v1';
const MAX_RANKING_WORK_ITEMS = 256;

function rankingError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function acquireRankingLock(conn, timeoutSeconds = 10) {
  const [[row]] = await conn.query(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [RANKING_LOCK_NAME, Math.max(0, Number(timeoutSeconds) || 0)]
  );
  if (Number(row?.acquired) !== 1) {
    throw rankingError('RANKING_LOCK_TIMEOUT', 'Ranking is busy. Please retry the product code.');
  }
  return true;
}

async function releaseRankingLock(conn) {
  const [[row]] = await conn.query('SELECT RELEASE_LOCK(?) AS released', [RANKING_LOCK_NAME]);
  return Number(row?.released) === 1;
}

async function getSponsorAncestors(conn, sourceUid) {
  const [rows] = await conn.query(
    `WITH RECURSIVE sponsor_chain AS (
       SELECT u.uid, u.drefid, 0 AS depth, CAST(CONCAT(',', u.uid, ',') AS CHAR(4000)) AS visited
         FROM usertab u
        WHERE u.uid = ?
       UNION ALL
       SELECT p.uid, p.drefid, c.depth + 1, CONCAT(c.visited, p.uid, ',')
         FROM sponsor_chain c
         JOIN usertab p ON p.uid = c.drefid
        WHERE c.depth < 30
          AND LOCATE(CONCAT(',', p.uid, ','), c.visited) = 0
     )
     SELECT uid, depth
       FROM sponsor_chain
      WHERE depth > 0
      ORDER BY depth ASC`,
    [Number(sourceUid)]
  );
  return rows.map((row) => Number(row.uid)).filter((uid) => uid > 0);
}

async function getBinaryAncestors(conn, memberUid) {
  const [rows] = await conn.query(
    `SELECT ancestor_uid AS uid
       FROM binary_tree_closuretab
      WHERE descendant_uid = ? AND depth > 0
      ORDER BY depth ASC, ancestor_uid ASC`,
    [Number(memberUid)]
  );
  return rows.map((row) => Number(row.uid)).filter((uid) => uid > 0);
}

async function getStoredRank(conn, memberUid) {
  const [[row]] = await conn.query(
    `SELECT GREATEST(COALESCE(highest_rank_no,0), COALESCE(current_rank,0), COALESCE(rank_level,0)) AS current_rank
       FROM rankingstab WHERE uid = ? LIMIT 1`,
    [Number(memberUid)]
  );
  return Number(row?.current_rank || 0);
}

async function processRepurchaseRankingEvent(conn, event, overrides = {}) {
  const repurchaseId = Number(event?.repurchaseId);
  const sourceMemberUid = Number(event?.sourceMemberUid);
  const points = Number(event?.points || 0);
  if (!repurchaseId || !sourceMemberUid || !Number.isFinite(points) || points <= 0) {
    throw rankingError('INVALID_RANKING_EVENT', 'A positive product-point event is required.');
  }

  const [existingRows] = await conn.query(
    'SELECT status FROM ranking_event_processstab WHERE repurchase_id = ? LIMIT 1 FOR UPDATE',
    [repurchaseId]
  );
  if (existingRows[0]?.status === 'completed') {
    return { alreadyProcessed: true, repurchaseId, affectedMemberUids: [] };
  }

  const processKey = createProcessKey(['ranking-repurchase', repurchaseId]);
  if (existingRows.length === 0) {
    await conn.query(
      `INSERT INTO ranking_event_processstab
         (repurchase_id, source_member_uid, points, process_key, status)
       VALUES (?, ?, ?, ?, 'processing')`,
      [repurchaseId, sourceMemberUid, points, processKey]
    );
  }

  const sponsorAncestors = overrides.getSponsorAncestors || getSponsorAncestors;
  const binaryAncestors = overrides.getBinaryAncestors || getBinaryAncestors;
  const currentRank = overrides.getCurrentRank || ((uid) => getStoredRank(conn, uid));
  const evaluateMember = overrides.evaluateMember || (async (uid) => {
    const evaluationContext = {
      memo: new Map(),
      stack: new Set(),
      definitions: null,
      excludedSet: null,
      recurseChildren: false,
      newConsumptionSourceUids: new Set(),
    };
    const snapshot = await rebuildRankSnapshot(uid, conn, evaluationContext);
    return {
      ...snapshot,
      dependencySourceUids: [...evaluationContext.newConsumptionSourceUids],
    };
  });
  const applyDelta = overrides.applyRepurchaseDelta || ((uid, value) => applyRepurchaseDelta(conn, uid, value));
  const makePublicId = overrides.createPublicId || createPublicId;

  await applyDelta(sourceMemberUid, points);

  const queue = [];
  const queued = new Set();
  const affected = [];
  const affectedSet = new Set();
  const enqueueUnique = (uids) => {
    for (const value of uids || []) {
      const uid = Number(value);
      if (!uid || uid === sourceMemberUid || queued.has(uid)) continue;
      queued.add(uid);
      queue.push(uid);
    }
  };

  enqueueUnique(await sponsorAncestors(sourceMemberUid));
  let iterations = 0;
  while (queue.length > 0) {
    if (++iterations > MAX_RANKING_WORK_ITEMS) {
      throw rankingError('RANKING_WORK_LIMIT', 'Ranking dependency work exceeded its safety limit.');
    }
    const uid = queue.shift();
    queued.delete(uid);
    const before = Number(await currentRank(uid)) || 0;
    const snapshot = await evaluateMember(uid);
    const after = Number(snapshot?.currentRank || 0);
    if (!affectedSet.has(uid)) {
      affectedSet.add(uid);
      affected.push(uid);
    }
    for (const dependencySourceUid of snapshot?.dependencySourceUids || []) {
      enqueueUnique(await sponsorAncestors(dependencySourceUid));
    }
    if (after > before) {
      enqueueUnique(await binaryAncestors(uid));
      enqueueUnique(await sponsorAncestors(uid));
    }
  }

  const eventUid = makePublicId();
  await conn.query(
    `INSERT INTO ranking_realtime_outboxtab
       (event_uid, repurchase_id, affected_member_uids, status)
     VALUES (?, ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE affected_member_uids = VALUES(affected_member_uids)`,
    [eventUid, repurchaseId, JSON.stringify(affected)]
  );
  await conn.query(
    `UPDATE ranking_event_processstab
        SET status = 'completed', affected_member_count = ?, completed_at = CURRENT_TIMESTAMP(6)
      WHERE repurchase_id = ?`,
    [affected.length, repurchaseId]
  );

  return { alreadyProcessed: false, repurchaseId, eventUid, affectedMemberUids: affected };
}

/**
 * Phase 1 (inside the purchase transaction): durably record that this repurchase
 * OWES ranking work — WITHOUT doing the work. Keyed by repurchase_id (PK) so it is
 * idempotent. This lets the member's maintenance/hi-five purchase COMMIT immediately;
 * the ranking cascade is run afterwards (best-effort) and, if that misses, the
 * realtime worker sweeps the committed 'processing' marker. Decoupling this from the
 * purchase means a ranking hiccup (lock timeout / work limit / restart) can never roll
 * back or block a member's maintenance (which itself gates their unilevel eligibility).
 */
async function recordPendingRankingEvent(conn, event) {
  const repurchaseId = Number(event?.repurchaseId);
  const sourceMemberUid = Number(event?.sourceMemberUid);
  const points = Number(event?.points || 0);
  if (!repurchaseId || !sourceMemberUid || !Number.isFinite(points) || points <= 0) {
    return false;
  }
  const processKey = createProcessKey(['ranking-repurchase', repurchaseId]);
  await conn.query(
    `INSERT INTO ranking_event_processstab
       (repurchase_id, source_member_uid, points, process_key, status)
     VALUES (?, ?, ?, ?, 'processing')
     ON DUPLICATE KEY UPDATE
       source_member_uid = VALUES(source_member_uid),
       points = VALUES(points)`,
    [repurchaseId, sourceMemberUid, points, processKey]
  );
  return true;
}

/**
 * Phase 2 (AFTER the purchase commit, on its OWN connection/transaction): run the
 * ranking cascade for a repurchase that has a durable 'processing' marker. Safe to call
 * repeatedly and from multiple callers at once (the in-request deferred call AND the
 * recovery sweeper): the per-repurchase `FOR UPDATE` inside processRepurchaseRankingEvent
 * plus the global advisory lock serialize them, and a 'completed' marker short-circuits
 * re-runs — so the gross-point delta can NEVER be applied twice. A failure here never
 * touches the already-committed purchase; the marker simply stays 'processing' for the
 * next sweep. (applyRepurchaseDelta is non-idempotent on its own, so it is critical that
 * the delta and the status='completed' write commit together in this single transaction.)
 */
async function runRankingEventInOwnTransaction(repurchaseId, deps = {}) {
  const id = Number(repurchaseId);
  if (!id) return { skipped: true, reason: 'invalid-id' };
  const getConnection = deps.getConnection || (() => pool.getConnection());
  const conn = await getConnection();
  let lockHeld = false;
  try {
    const [[marker]] = await conn.query(
      `SELECT repurchase_id, source_member_uid, points, status
         FROM ranking_event_processstab WHERE repurchase_id = ? LIMIT 1`,
      [id]
    );
    if (!marker) return { skipped: true, reason: 'no-marker', repurchaseId: id };
    if (marker.status === 'completed') {
      return { skipped: true, reason: 'already-completed', repurchaseId: id };
    }

    await conn.beginTransaction();
    await acquireRankingLock(conn);
    lockHeld = true;
    const result = await processRepurchaseRankingEvent(conn, {
      repurchaseId: Number(marker.repurchase_id),
      sourceMemberUid: Number(marker.source_member_uid),
      points: Number(marker.points),
    });
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch (rollbackError) { /* surface original */ }
    throw error;
  } finally {
    if (lockHeld) {
      try { await releaseRankingLock(conn); } catch (releaseError) { /* lock auto-frees on disconnect */ }
    }
    conn.release();
  }
}

module.exports = {
  RANKING_LOCK_NAME,
  MAX_RANKING_WORK_ITEMS,
  acquireRankingLock,
  releaseRankingLock,
  getSponsorAncestors,
  getBinaryAncestors,
  processRepurchaseRankingEvent,
  recordPendingRankingEvent,
  runRankingEventInOwnTransaction,
};
