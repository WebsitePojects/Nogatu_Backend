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

module.exports = {
  RANKING_LOCK_NAME,
  MAX_RANKING_WORK_ITEMS,
  acquireRankingLock,
  releaseRankingLock,
  getSponsorAncestors,
  getBinaryAncestors,
  processRepurchaseRankingEvent,
};
