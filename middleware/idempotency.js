/**
 * Idempotency-key middleware — exactly-once semantics for state-changing endpoints.
 *
 * Contract (Stripe-style):
 *   - Client sends `Idempotency-Key` header (or `idempotencyKey` in the body) with a
 *     unique value per LOGICAL action (one per button press / form submission).
 *   - First request to arrive claims the key (INSERT into idempotency_keystab,
 *     UNIQUE(scope, actor_uid, idem_key)) and executes the handler normally.
 *   - A duplicate arriving while the first is still running gets 409 (in progress).
 *   - A duplicate arriving after completion gets the ORIGINAL response replayed
 *     (marked with `Idempotency-Replayed: true`), so a double-tap can never run
 *     the handler twice.
 *   - Reusing a key with a DIFFERENT request body is rejected with 422.
 *
 * Design constraints:
 *   - FAIL-OPEN: any internal error here falls through to the handler. This layer
 *     is deduplication/UX; the per-row CAS guards in the handlers (e.g.
 *     `UPDATE codestab ... AND codestatus = 1`) are the hard money wall. Never
 *     let a dedupe-bookkeeping failure block a legitimate request.
 *   - Only 2xx responses are stored for replay. Failures release the key so the
 *     member can retry the same action with the same key.
 *   - A `processing` row older than PROCESSING_TAKEOVER_MS is treated as a crashed
 *     handler: the claim is taken over rather than 409ing forever.
 *   - Keys without a session actor still work (public registration): actor_uid=0,
 *     with the request-hash guard preventing cross-user key collisions from
 *     replaying someone else's response.
 */
const crypto = require('crypto');
// Lazy: importing this module must never construct the DB pool (keeps unit
// tests and ad-hoc scripts from needing a live config/database).
let lazyPool = null;
function getDefaultPool() {
  if (!lazyPool) lazyPool = require('../config/database').pool;
  return lazyPool;
}

const PROCESSING_TAKEOVER_MS = 60 * 1000;
const CLEANUP_PROBABILITY = 0.001; // ~1 in 1000 requests sweeps expired keys
const CLEANUP_MAX_AGE_DAYS = 7;

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashRequest(req) {
  const body = { ...(req.body || {}) };
  delete body.idempotencyKey; // the key itself is not part of the payload identity
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${req.baseUrl}${req.path}\n${stableStringify(body)}`)
    .digest('hex');
}

function createIdempotency(injectedPool = null) {
  /**
   * @param {string} scope stable route identifier, e.g. 'codes.maintenance'
   */
  return function idempotent(scope) {
    return async function idempotencyGuard(req, res, next) {
      let claimed = false;
      let actorUid = 0;
      let idemKey = '';
      let pool;
      try {
        pool = injectedPool || getDefaultPool();
        const raw = req.get('Idempotency-Key') || req.body?.idempotencyKey || '';
        if (!raw || !KEY_RE.test(raw)) return next(); // no/invalid key -> CAS still guards
        idemKey = raw;
        actorUid = Number(req.session?.uid || req.session?.adminNumericId || 0) || 0;
        const requestHash = hashRequest(req);

        try {
          await pool.query(
            'INSERT INTO idempotency_keystab (idem_key, scope, actor_uid, request_hash) VALUES (?, ?, ?, ?)',
            [idemKey, scope, actorUid, requestHash]
          );
          claimed = true;
        } catch (err) {
          if (err.code !== 'ER_DUP_ENTRY') throw err;

          const [rows] = await pool.query(
            `SELECT status, response_code, response_body, request_hash,
                    created_at < (NOW(6) - INTERVAL ${Math.floor(PROCESSING_TAKEOVER_MS / 1000)} SECOND) AS stale
             FROM idempotency_keystab
             WHERE scope = ? AND actor_uid = ? AND idem_key = ? LIMIT 1`,
            [scope, actorUid, idemKey]
          );
          const row = rows[0];
          if (!row) return next(); // cleanup race — proceed; CAS guards

          if (row.request_hash && row.request_hash !== requestHash) {
            return res.status(422).json({
              error: 'This idempotency key was already used for a different request.',
            });
          }
          if (row.status === 'done') {
            res.set('Idempotency-Replayed', 'true');
            let body;
            try { body = JSON.parse(row.response_body || '{}'); } catch { body = {}; }
            return res.status(row.response_code || 200).json(body);
          }
          // status = processing
          if (Number(row.stale) === 1) {
            // Crashed/hung first attempt: take over the claim atomically.
            const [takeover] = await pool.query(
              `DELETE FROM idempotency_keystab
               WHERE scope = ? AND actor_uid = ? AND idem_key = ? AND status = 'processing'
                 AND created_at < (NOW(6) - INTERVAL ${Math.floor(PROCESSING_TAKEOVER_MS / 1000)} SECOND)
               LIMIT 1`,
              [scope, actorUid, idemKey]
            );
            if (takeover.affectedRows === 1) {
              await pool.query(
                'INSERT INTO idempotency_keystab (idem_key, scope, actor_uid, request_hash) VALUES (?, ?, ?, ?)',
                [idemKey, scope, actorUid, requestHash]
              );
              claimed = true;
            } else {
              return res.status(409).json({ error: 'This request is already being processed. Please wait.' });
            }
          } else {
            return res.status(409).json({ error: 'This request is already being processed. Please wait.' });
          }
        }

        // First (or taken-over) claim: capture the response for replay / release.
        const originalJson = res.json.bind(res);
        res.json = (body) => {
          const status = res.statusCode || 200;
          const success = status >= 200 && status < 300;
          (async () => {
            try {
              if (success) {
                await pool.query(
                  `UPDATE idempotency_keystab
                   SET status = 'done', response_code = ?, response_body = ?, completed_at = NOW(6)
                   WHERE scope = ? AND actor_uid = ? AND idem_key = ? LIMIT 1`,
                  [status, JSON.stringify(body ?? {}), scope, actorUid, idemKey]
                );
              } else {
                // Failed attempts release the key so the same action can be retried.
                await pool.query(
                  'DELETE FROM idempotency_keystab WHERE scope = ? AND actor_uid = ? AND idem_key = ? LIMIT 1',
                  [scope, actorUid, idemKey]
                );
              }
            } catch (err) {
              console.error('[Idempotency] finalize failed:', err.message);
            }
          })();
          return originalJson(body);
        };

        if (Math.random() < CLEANUP_PROBABILITY) {
          pool
            .query(
              `DELETE FROM idempotency_keystab
               WHERE created_at < (NOW(6) - INTERVAL ${CLEANUP_MAX_AGE_DAYS} DAY) LIMIT 500`
            )
            .catch((err) => console.error('[Idempotency] cleanup failed:', err.message));
        }

        return next();
      } catch (err) {
        console.error('[Idempotency] middleware error (failing open):', err.message);
        if (claimed) {
          // Don't leave an orphan claim that would 409 the retry for 60s.
          pool
            .query(
              'DELETE FROM idempotency_keystab WHERE scope = ? AND actor_uid = ? AND idem_key = ? LIMIT 1',
              [scope, actorUid, idemKey]
            )
            .catch(() => {});
        }
        return next();
      }
    };
  };
}

module.exports = { idempotent: createIdempotency(), createIdempotency, stableStringify, hashRequest };
