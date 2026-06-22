const { pool } = require('../config/database');
const events = require('../routes/events');
const { runRankingEventInOwnTransaction } = require('./rankingEventProcessor');

const POLL_INTERVAL_MS = 1000;
const LEASE_SECONDS = 30;
// Grace window before the recovery sweeper adopts a 'processing' marker — long enough
// for the in-request deferred attempt to finish on its own first.
const STALE_EVENT_GRACE_SECONDS = 10;
let workerTimer = null;
let workerBusy = false;

function parseAffectedMemberUids(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(Number).filter((uid) => uid > 0))];
  } catch {
    return [];
  }
}

function committedAtFor(row) {
  const value = new Date(row?.created_at || Date.now());
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

async function publishOutboxRow(row, publishers = events) {
  const eventUid = String(row.event_uid || '');
  const repurchaseId = Number(row.repurchase_id);
  const committedAt = committedAtFor(row);
  const affectedMemberUids = parseAffectedMemberUids(row.affected_member_uids);

  for (const memberUid of affectedMemberUids) {
    publishers.publishToUser(memberUid, 'ranking.member.updated', {
      eventUid, repurchaseId, memberUid, committedAt,
    });
  }
  const leaderboardPayload = { eventUid, repurchaseId, committedAt };
  publishers.publishToAllUsers('ranking.leaderboard.updated', leaderboardPayload);
  publishers.publishToAdmins('ranking.leaderboard.updated', leaderboardPayload);
  return { affectedMemberUids };
}

async function claimRows({ repurchaseId = null, limit = 20 } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const params = [];
    let filter = '';
    if (Number(repurchaseId) > 0) {
      filter = ' AND repurchase_id = ?';
      params.push(Number(repurchaseId));
    }
    params.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const [rows] = await conn.query(
      `SELECT id, event_uid, repurchase_id, affected_member_uids, attempts, created_at
         FROM ranking_realtime_outboxtab
        WHERE status IN ('pending','publishing')
          AND available_at <= CURRENT_TIMESTAMP(6)${filter}
        ORDER BY id ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      params
    );
    if (rows.length > 0) {
      await conn.query(
        `UPDATE ranking_realtime_outboxtab
            SET status = 'publishing', attempts = attempts + 1,
                available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? SECOND)
          WHERE id IN (?)`,
        [LEASE_SECONDS, rows.map((row) => row.id)]
      );
    }
    await conn.commit();
    return rows;
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

async function publishClaimedRows(rows) {
  let published = 0;
  for (const row of rows) {
    try {
      await publishOutboxRow(row);
      await pool.query(
        `UPDATE ranking_realtime_outboxtab
            SET status = 'published', published_at = CURRENT_TIMESTAMP(6), last_error = NULL
          WHERE id = ?`,
        [row.id]
      );
      published += 1;
    } catch (error) {
      const delaySeconds = Math.min(30, 2 ** Math.min(5, Number(row.attempts || 0) + 1));
      await pool.query(
        `UPDATE ranking_realtime_outboxtab
            SET status = 'pending', last_error = ?,
                available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? SECOND)
          WHERE id = ?`,
        [String(error?.message || error).slice(0, 1000), delaySeconds, row.id]
      );
    }
  }
  return published;
}

async function flushRankingOutboxForRepurchase(repurchaseId) {
  return publishClaimedRows(await claimRows({ repurchaseId, limit: 1 }));
}

async function flushPendingRankingOutbox(limit = 20) {
  return publishClaimedRows(await claimRows({ limit }));
}

/**
 * Run a repurchase's ranking cascade in its own transaction, then publish the SSE
 * invalidations so every connected member/admin re-sorts live. Used by BOTH the
 * post-commit deferred call in the maintenance route and the recovery sweeper.
 * Idempotent end-to-end (see runRankingEventInOwnTransaction).
 */
async function processAndPublishRankingEvent(repurchaseId) {
  const result = await runRankingEventInOwnTransaction(repurchaseId);
  try {
    await flushRankingOutboxForRepurchase(repurchaseId);
  } catch (error) {
    console.error('[RankingRealtime] publish after process failed; recovery worker will retry:', error.message);
  }
  return result;
}

/**
 * Recovery: any repurchase whose post-commit ranking attempt did not finish (server
 * restart, lock timeout, transient error) leaves a durable 'processing' marker. Adopt
 * the ones older than the grace window and complete them. This is what makes the live
 * leaderboard self-healing globally — no operator step required.
 */
async function sweepStaleRankingEvents(limit = 20) {
  const [rows] = await pool.query(
    `SELECT repurchase_id
       FROM ranking_event_processstab
      WHERE status = 'processing'
        AND started_at < (CURRENT_TIMESTAMP(6) - INTERVAL ? SECOND)
      ORDER BY started_at ASC
      LIMIT ?`,
    [STALE_EVENT_GRACE_SECONDS, Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  let processed = 0;
  for (const row of rows) {
    try {
      await processAndPublishRankingEvent(Number(row.repurchase_id));
      processed += 1;
    } catch (error) {
      console.error('[RankingRealtime] stale ranking sweep failed for', row.repurchase_id, error.message);
    }
  }
  return processed;
}

function startRankingRealtimeWorker() {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await flushPendingRankingOutbox();
      await sweepStaleRankingEvents();
    } catch (error) {
      console.error('[RankingRealtime] recovery poll failed:', error.message);
    } finally {
      workerBusy = false;
    }
  }, POLL_INTERVAL_MS);
  workerTimer.unref?.();
  return workerTimer;
}

function stopRankingRealtimeWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  workerBusy = false;
}

module.exports = {
  parseAffectedMemberUids,
  publishOutboxRow,
  flushRankingOutboxForRepurchase,
  flushPendingRankingOutbox,
  processAndPublishRankingEvent,
  sweepStaleRankingEvents,
  startRankingRealtimeWorker,
  stopRankingRealtimeWorker,
};
