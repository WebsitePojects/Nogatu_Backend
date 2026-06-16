/**
 * Durable background worker over the existing `job_queuetab`.
 *
 * Design (no Redis needed — MySQL is the queue):
 *  - Poll on an interval; lease one queued job atomically (status flip guarded by
 *    affectedRows so two workers/processes never grab the same row).
 *  - On success -> status='done'. On error -> retry with exponential backoff via
 *    `available_at`, or 'failed' after MAX_ATTEMPTS.
 *  - Idempotent enqueue via the unique `job_key`.
 *
 * Current job types:
 *  - 'support_orphan_sweep': delete Cloudinary assets in the support folder that
 *    were uploaded (browser direct upload) but never attached to a sent message,
 *    so abandoned uploads don't leak storage/cost at 5-10k-user scale.
 */
const os = require('os');
const { pool } = require('../config/database');
const { cloudinary } = require('../utils/cloudinary');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_MS = 15000;
const MAX_ATTEMPTS = 5;
const ORPHAN_TTL_HOURS = 6;
const SWEEP_INTERVAL_MIN = 60;

const handlers = {
  support_orphan_sweep: handleOrphanSweep,
};

async function enqueue(jobKey, jobType, payload = {}, delaySeconds = 0) {
  await pool.query(
    `INSERT INTO job_queuetab (job_key, job_type, payload, status, available_at)
     VALUES (?, ?, ?, 'queued', DATE_ADD(NOW(6), INTERVAL ? SECOND))
     ON DUPLICATE KEY UPDATE id = id`,
    [jobKey, jobType, JSON.stringify(payload || {}), Math.max(0, delaySeconds)]
  );
}

async function leaseOne() {
  const [rows] = await pool.query(
    `SELECT id, job_type, payload, attempts FROM job_queuetab
      WHERE status = 'queued' AND available_at <= NOW(6)
      ORDER BY available_at ASC, id ASC LIMIT 1`
  );
  const job = rows[0];
  if (!job) return null;
  const [upd] = await pool.query(
    `UPDATE job_queuetab
        SET status='processing', locked_at=NOW(6), locked_by=?, attempts=attempts+1
      WHERE id=? AND status='queued'`,
    [WORKER_ID, job.id]
  );
  if (upd.affectedRows !== 1) return null; // lost the race; try again next tick
  return job;
}

async function finish(id, ok, errMsg) {
  if (ok) {
    await pool.query("UPDATE job_queuetab SET status='done', last_error=NULL WHERE id=?", [id]);
    return;
  }
  const [rows] = await pool.query('SELECT attempts FROM job_queuetab WHERE id=? LIMIT 1', [id]);
  const attempts = Number(rows[0]?.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query("UPDATE job_queuetab SET status='failed', last_error=? WHERE id=?", [String(errMsg).slice(0, 1000), id]);
  } else {
    const backoff = Math.min(3600, 2 ** attempts * 30); // 30s,60s,120s,... capped 1h
    await pool.query(
      "UPDATE job_queuetab SET status='queued', available_at=DATE_ADD(NOW(6), INTERVAL ? SECOND), last_error=? WHERE id=?",
      [backoff, String(errMsg).slice(0, 1000), id]
    );
  }
}

async function tick() {
  try {
    const job = await leaseOne();
    if (!job) return;
    const handler = handlers[job.job_type];
    try {
      if (!handler) throw new Error(`No handler for job_type ${job.job_type}`);
      let payload = {};
      try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }
      await handler(payload);
      await finish(job.id, true);
    } catch (err) {
      console.error(`[jobWorker] ${job.job_type} failed:`, err.message);
      await finish(job.id, false, err.message);
    }
  } catch (err) {
    console.error('[jobWorker] tick error:', err.message);
  }
}

// --- Orphan sweep: delete Cloudinary assets never attached to a message ---
async function handleOrphanSweep() {
  if (!cloudinary) return; // nothing to sweep when uploads are unconfigured
  const cutoffMs = Date.now() - ORPHAN_TTL_HOURS * 3600 * 1000;
  let nextCursor;
  let deleted = 0;
  do {
    const res = await cloudinary.api.resources({
      type: 'upload', prefix: 'nogatu/support', max_results: 100, next_cursor: nextCursor,
    });
    nextCursor = res.next_cursor;
    const candidates = (res.resources || []).filter((r) => new Date(r.created_at).getTime() < cutoffMs);
    if (candidates.length) {
      const ids = candidates.map((r) => r.public_id);
      const [refRows] = await pool.query(
        'SELECT public_id FROM support_message_attachmentstab WHERE public_id IN (?)',
        [ids]
      );
      const referenced = new Set(refRows.map((r) => r.public_id));
      for (const r of candidates) {
        if (!referenced.has(r.public_id)) {
          try {
            await cloudinary.uploader.destroy(r.public_id, { resource_type: r.resource_type || 'image' });
            deleted += 1;
          } catch (e) { console.error('[jobWorker] destroy failed', r.public_id, e.message); }
        }
      }
    }
  } while (nextCursor);
  if (deleted) console.log(`[jobWorker] orphan sweep removed ${deleted} unused upload(s)`);
  // Self-schedule the next sweep.
  await enqueue(`orphan_sweep_${Date.now()}`, 'support_orphan_sweep', {}, SWEEP_INTERVAL_MIN * 60);
}

let started = false;
function startWorker() {
  if (started) return;
  started = true;
  // Seed a sweep shortly after boot, then it self-schedules.
  enqueue('orphan_sweep_boot', 'support_orphan_sweep', {}, 120).catch(() => {});
  setInterval(() => { tick(); }, POLL_MS).unref?.();
  console.log('[jobWorker] started (job_queuetab poller)');
}

module.exports = { startWorker, enqueue };
