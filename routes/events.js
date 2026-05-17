const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');

router.get('/stream', memberAuth, (req, res) => {
  const uid = Number(req.session.uid);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', {
    uid,
    asOf: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    send('heartbeat', { uid, asOf: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

module.exports = router;
