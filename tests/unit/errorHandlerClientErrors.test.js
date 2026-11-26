// Bad request bodies must come back as 4xx, not 500 (found by the 2026-11-24
// differential E2E: malformed JSON, a body over 100kb and a corrupt gzip body all
// returned 500). Runs REAL body-parser errors through the real handler over HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { errorHandler } = require('../../middleware/errorHandler');

function buildApp() {
  const app = express();
  // Same parser configuration as index.js.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.post('/echo', (req, res) => res.json({ ok: true }));
  app.get('/boom', () => { throw new Error('database exploded: secret-detail'); });
  app.get('/fake-status', () => { const e = new Error('looks like 400'); e.status = 400; throw e; });
  app.use(errorHandler);
  return app;
}

function send(server, { method = 'POST', urlPath = '/echo', headers = {}, body }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server;
test.before(async () => {
  server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
test.after(() => new Promise((r) => server.close(r)));

const quiet = () => {
  const saved = { warn: console.warn, error: console.error };
  console.warn = () => {}; console.error = () => {};
  return () => { console.warn = saved.warn; console.error = saved.error; };
};

test('malformed JSON is a 400, not a 500', async () => {
  const restore = quiet();
  try {
    const r = await send(server, { headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Invalid request body' });
  } finally { restore(); }
});

test('a body over the 100kb limit is a 413', async () => {
  const restore = quiet();
  try {
    const big = JSON.stringify({ pad: 'x'.repeat(150 * 1024) });
    const r = await send(server, { headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(r.status, 413);
    assert.deepEqual(r.body, { error: 'Request body too large' });
  } finally { restore(); }
});

test('a corrupt gzip body is a 400', async () => {
  const restore = quiet();
  try {
    const r = await send(server, {
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: Buffer.from('this is not gzip at all'),
    });
    assert.equal(r.status, 400);
  } finally { restore(); }
});

test('an unknown Content-Encoding is a 415', async () => {
  const restore = quiet();
  try {
    const r = await send(server, {
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'x-made-up' },
      body: '{}',
    });
    assert.equal(r.status, 415);
  } finally { restore(); }
});

test('a valid body still reaches the route', async () => {
  const r = await send(server, { headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(r.status, 200);
});

test('a real server fault stays a 500 and never leaks its message', async () => {
  const restore = quiet();
  try {
    const r = await send(server, { method: 'GET', urlPath: '/boom' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Internal server error' });
  } finally { restore(); }
});

test('a plain Error carrying status 400 without expose is still a 500 (fail closed)', async () => {
  const restore = quiet();
  try {
    const r = await send(server, { method: 'GET', urlPath: '/fake-status' });
    assert.equal(r.status, 500);
  } finally { restore(); }
});

test('index.js installs this handler and no other inline error handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.match(src, /require\('\.\/middleware\/errorHandler'\)/);
  assert.match(src, /app\.use\(errorHandler\);/);
  assert.doesNotMatch(src, /app\.use\(\(err,\s*req,\s*res,\s*next\)/);
});
