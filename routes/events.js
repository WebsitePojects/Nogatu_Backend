const express = require('express');
const router = express.Router();
const { memberAuth, adminAuth } = require('../middleware/auth');

// ── In-process SSE pub/sub hub ───────────────────────────────────────────────
// Members subscribe to their own uid channel; admins all share one 'admin' room.
// Single-process only (PM2 fork mode, one instance) — matches the live deploy.
// Support event names: 'support.reply', 'support.read', 'support.status'.
const memberClients = new Map(); // uid(number) -> Set<res>
const adminClients = new Set();  // Set<res>

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* connection already torn down; cleanup happens on 'close' */
  }
}

// Returns the number of live connections the event was written to (0 = recipient
// offline). Callers use this to decide whether a message counts as 'delivered'.
function publishToUser(uid, event, data) {
  const set = memberClients.get(Number(uid));
  if (!set) return 0;
  let n = 0;
  for (const res of set) { writeEvent(res, event, data); n += 1; }
  return n;
}

function publishToAdmins(event, data) {
  let n = 0;
  for (const res of adminClients) { writeEvent(res, event, data); n += 1; }
  return n;
}

function openStream(req, res, registry, key) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (registry instanceof Map) {
    const bucket = registry.get(key) || new Set();
    bucket.add(res);
    registry.set(key, bucket);
  } else {
    registry.add(res);
  }

  writeEvent(res, 'connected', { key, asOf: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    writeEvent(res, 'heartbeat', { asOf: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (registry instanceof Map) {
      const set = registry.get(key);
      if (set) {
        set.delete(res);
        if (set.size === 0) registry.delete(key);
      }
    } else {
      registry.delete(res);
    }
  });
}

// Member live stream — subscribes to the member's own uid channel.
router.get('/stream', memberAuth, (req, res) => {
  openStream(req, res, memberClients, Number(req.session.uid));
});

// Admin live stream — all admins share the 'admin' room.
router.get('/admin/stream', adminAuth, (req, res) => {
  openStream(req, res, adminClients, 'admin');
});

router.publishToUser = publishToUser;
router.publishToAdmins = publishToAdmins;

module.exports = router;
