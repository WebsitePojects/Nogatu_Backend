/**
 * nogatu.store -> nogatualliance.com member check (server to server).
 *
 * POST /api/external/member/verify  { username, password }  with header x-api-key: <NCDMS_BRIDGE_KEY>
 *   200 { data: { verified: true, uid, username, account_status } }  credentials match
 *   401 { error }                                                     wrong username or password
 *   403 / 503                                                         bad key / bridge not configured
 *
 * nogatu.store gives a member the member price only after this check, so a typed username alone gets
 * nothing. The password is compared with the same matchesStoredPassword login uses and is never stored,
 * logged or upgraded here; no session is created. NCDMS decides what account_status still earns the discount.
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { matchesStoredPassword } = require('../utils/passwordPolicy');
const { normalizeLegacyUsername } = require('../utils/legacyUsername');

const WINDOW_MS = 15 * 60 * 1000;
// Spent when no account matches, so a missing username takes as long to answer as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('nogatu-store-member-check', 10);

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {{ pool: { query: Function }, getApiKey?: () => string, limiter?: boolean }} deps
 */
function createExternalMemberRouter({ pool, getApiKey = () => process.env.NCDMS_BRIDGE_KEY, limiter = true }) {
  const router = express.Router();

  // Fail closed: no key configured means the bridge is off; a wrong key is refused before any lookup.
  router.use((req, res, next) => {
    const expected = String(getApiKey() || '');
    if (!expected) return res.status(503).json({ error: 'Member bridge is not configured' });
    if (!sameSecret(req.get('x-api-key'), expected)) return res.status(403).json({ error: 'Forbidden' });
    return next();
  });

  if (limiter) {
    // A second guard behind nogatu.store's own limits: five wrong passwords per username per window.
    router.use('/member/verify', rateLimit({
      windowMs: WINDOW_MS,
      max: 5,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => `ncdms-member:${normalizeLegacyUsername(req.body?.username).toLowerCase()}`,
      message: { error: 'Too many attempts for this member. Please try again after 15 minutes.' },
      standardHeaders: true,
      legacyHeaders: false,
    }));
  }

  router.post('/member/verify', async (req, res) => {
    const username = normalizeLegacyUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || password.length > 200) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    try {
      const [rows] = await pool.query(
        `SELECT u.uid, u.public_uid, u.account_status, m.username, m.password
         FROM memberstab m JOIN usertab u ON u.uid = m.uid
         WHERE m.username = ? LIMIT 1`,
        [username]
      );
      const member = rows[0];
      if (!member) {
        await bcrypt.compare(password, DUMMY_HASH);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (!(await matchesStoredPassword(password, member.password))) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      return res.json({
        data: {
          verified: true,
          uid: String(member.public_uid || member.uid),
          username: member.username,
          // Login treats an empty status as active; so does this answer.
          account_status: String(member.account_status || 'active').trim().toLowerCase(),
        },
      });
    } catch (err) {
      console.error('[external/member/verify] lookup failed:', err.message);
      return res.status(500).json({ error: 'Member check failed' });
    }
  });

  return router;
}

module.exports = { createExternalMemberRouter };
