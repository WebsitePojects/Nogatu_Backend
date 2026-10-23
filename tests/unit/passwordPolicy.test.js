'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const {
  validateNewPassword,
  matchesStoredPassword,
  SAME_AS_CURRENT_ERROR,
} = require('../../utils/passwordPolicy');

const repoRoot = path.resolve(__dirname, '..', '..');
const STRONG = 'Mango-Tree-River-42';

// ── The rules ────────────────────────────────────────────────────────────

test('policy: accepts a reasonable password', () => {
  assert.deepEqual(validateNewPassword(STRONG, { username: 'ana01', email: 'ana@example.test' }), { ok: true });
});

test('policy: rejects short, over-72-byte, padded, common, repeated and digit-run passwords', () => {
  const bad = [
    '', 'short7', 'a'.repeat(73), 'é'.repeat(37), ` ${STRONG}`, `${STRONG} `,
    'password123', 'PASSWORD123', 'Nogatu2026', '12345678', '87654321', '0123456789', 'zzzzzzzz',
  ];
  for (const candidate of bad) {
    assert.equal(validateNewPassword(candidate).ok, false, `should reject ${JSON.stringify(candidate)}`);
  }
});

test('policy: 72 bytes is the ceiling, counted in bytes not characters', () => {
  assert.equal(validateNewPassword('k'.repeat(72)).ok, false, 'one repeated char is rejected for another reason');
  assert.equal(validateNewPassword('kq'.repeat(36)).ok, true);
  assert.equal(validateNewPassword('kq'.repeat(36) + 'x').ok, false);
});

test('policy: rejects the username or the email name inside the password, case-insensitively', () => {
  assert.equal(validateNewPassword('xxANA01xx-9', { username: 'ana01' }).ok, false);
  assert.equal(validateNewPassword('my-anacruz-77', { email: 'AnaCruz@example.test' }).ok, false);
  assert.equal(validateNewPassword(STRONG, { username: 'jo' }).ok, true, 'very short usernames are not checked');
});

test('matchesStoredPassword: bcrypt, PHP plaintext, md5 and sha1 are all recognised', async () => {
  const pw = STRONG;
  assert.equal(await matchesStoredPassword(pw, await bcrypt.hash(pw, 4)), true);
  assert.equal(await matchesStoredPassword(pw, pw), true);
  assert.equal(await matchesStoredPassword(pw, crypto.createHash('md5').update(pw).digest('hex')), true);
  assert.equal(await matchesStoredPassword(pw, crypto.createHash('sha1').update(pw).digest('hex').toUpperCase()), true);
  assert.equal(await matchesStoredPassword('Other-Secret-99', await bcrypt.hash(pw, 4)), false);
  assert.equal(await matchesStoredPassword(pw, null), false);
});

// ── Routes, with the database stubbed ────────────────────────────────────

function stubModule(relativePath, exports) {
  const absolute = path.join(repoRoot, relativePath);
  const saved = require.cache[absolute];
  require.cache[absolute] = { id: absolute, filename: absolute, loaded: true, exports };
  return () => { if (saved) require.cache[absolute] = saved; else delete require.cache[absolute]; };
}

function loadRoute(relativePath, stubs) {
  const routePath = path.join(repoRoot, relativePath);
  delete require.cache[routePath];
  const restores = Object.entries(stubs).map(([p, e]) => stubModule(p, e));
  try {
    return require(routePath);
  } finally {
    restores.forEach((restore) => restore());
    delete require.cache[routePath];
  }
}

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(handler, body, session = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ body, session, ip: '127.0.0.1', headers: {}, get: () => undefined }, res);
  return res;
}

function fakeResetDb({ tokenValid = true, member }) {
  const log = { updates: [], committed: false, rolledBack: false, gotConnection: false };
  const conn = {
    beginTransaction: async () => {},
    commit: async () => { log.committed = true; },
    rollback: async () => { log.rolledBack = true; },
    release: () => {},
    query: async (sql, params) => {
      if (/FROM password_reset_tokenstab/.test(sql)) return [tokenValid ? [{ id: 9, member_uid: 7 }] : []];
      if (/SELECT username, email, password FROM memberstab/.test(sql)) return [[member]];
      if (/^\s*(UPDATE|DELETE)/.test(sql)) { log.updates.push({ sql, params }); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  };
  const pool = {
    getConnection: async () => { log.gotConnection = true; return conn; },
    query: async () => [[]],
  };
  return { pool, log };
}

function loadAuthRoutes(pool, mailer = { sendPasswordResetEmail: async () => ({ sent: true }) }) {
  return loadRoute('routes/auth.js', {
    'config/database.js': { pool },
    'services/audit.js': { writeAuditLog: async () => {} },
    'services/mailer.js': mailer,
  });
}

test('reset: the new password cannot be the current one (bcrypt) — rejected, rolled back, token left unused', async () => {
  const member = { username: 'ana01', email: 'ana@example.test', password: await bcrypt.hash(STRONG, 4) };
  const { pool, log } = fakeResetDb({ member });
  const handler = handlerFor(loadAuthRoutes(pool), 'post', '/reset-password');

  const res = await call(handler, { token: 'tok', newPassword: STRONG, confirmPassword: STRONG });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, SAME_AS_CURRENT_ERROR);
  assert.equal(log.rolledBack, true);
  assert.equal(log.committed, false);
  assert.equal(log.updates.length, 0, 'neither the password nor the token may be written');
});

test('reset: a PHP-era plaintext current password is also recognised as the same', async () => {
  const { pool, log } = fakeResetDb({ member: { username: 'ana01', email: 'ana@example.test', password: STRONG } });
  const res = await call(handlerFor(loadAuthRoutes(pool), 'post', '/reset-password'),
    { token: 'tok', newPassword: STRONG, confirmPassword: STRONG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, SAME_AS_CURRENT_ERROR);
  assert.equal(log.updates.length, 0);
});

test('reset: a password containing the username is rejected after the token check', async () => {
  const { pool, log } = fakeResetDb({ member: { username: 'ana01', email: 'ana@example.test', password: 'old-one-55' } });
  const res = await call(handlerFor(loadAuthRoutes(pool), 'post', '/reset-password'),
    { token: 'tok', newPassword: 'ana01-garden-77', confirmPassword: 'ana01-garden-77' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /username/);
  assert.equal(log.updates.length, 0);
});

test('reset: weak or mismatched input is refused before any database work', async () => {
  const { pool, log } = fakeResetDb({ member: {} });
  const handler = handlerFor(loadAuthRoutes(pool), 'post', '/reset-password');

  assert.equal((await call(handler, { token: 'tok', newPassword: '12345678', confirmPassword: '12345678' })).statusCode, 400);
  assert.equal((await call(handler, { token: 'tok', newPassword: STRONG, confirmPassword: `${STRONG}x` })).statusCode, 400);
  assert.equal(log.gotConnection, false);
});

test('reset: a valid new password is stored as bcrypt and the token is marked used, in one commit', async () => {
  const { pool, log } = fakeResetDb({ member: { username: 'ana01', email: 'ana@example.test', password: await bcrypt.hash('Old-Secret-31', 4) } });
  const res = await call(handlerFor(loadAuthRoutes(pool), 'post', '/reset-password'),
    { token: 'tok', newPassword: STRONG, confirmPassword: STRONG });

  assert.equal(res.statusCode, 200);
  assert.equal(log.committed, true);
  const pwUpdate = log.updates.find((u) => /UPDATE memberstab SET password/.test(u.sql));
  assert.ok(pwUpdate);
  assert.equal(await bcrypt.compare(STRONG, pwUpdate.params[0]), true);
  assert.ok(log.updates.some((u) => /UPDATE password_reset_tokenstab SET used_at/.test(u.sql)));
});

test('forgot: the reset token is never in the response, even with NODE_ENV=development', async () => {
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, CLIENT_URL: process.env.CLIENT_URL };
  process.env.NODE_ENV = 'development';
  process.env.CLIENT_URL = 'https://portal.example.test';
  const sent = [];
  const pool = {
    query: async (sql) => (/FROM memberstab/.test(sql)
      ? [[{ uid: 7, username: 'ana01', email: 'ana@example.test', firstname: 'Ana' }]]
      : [{ affectedRows: 1 }]),
  };
  try {
    const handler = handlerFor(loadAuthRoutes(pool, { sendPasswordResetEmail: async (p) => { sent.push(p); return { sent: true }; } }),
      'post', '/forgot-password');
    const res = await call(handler, { email: 'ana@example.test' });
    await new Promise((r) => setImmediate(r));

    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1, 'the email is still sent');
    const token = new URL(sent[0].resetUrl).searchParams.get('token');
    assert.ok(token && token.length === 64);
    assert.ok(!JSON.stringify(res.body).includes(token), 'token leaked in the HTTP response');
    assert.equal(res.body.debugResetToken, undefined);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('login: debugCode (username enumeration) is not returned just because NODE_ENV is not production', async () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  delete process.env.AUTH_DEBUG_CODES;
  try {
    const pool = { query: async () => [[]] };
    const res = await call(handlerFor(loadAuthRoutes(pool), 'post', '/login'), { username: 'nobody99', password: 'whatever-1' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.debugCode, undefined);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
  }
});

test('account page: changing to the current password is refused and nothing is written', async () => {
  const writes = [];
  const current = { username: 'ana01', email: 'ana@example.test', password: await bcrypt.hash(STRONG, 4) };
  const pool = {
    query: async (sql, params) => {
      if (/information_schema/.test(sql)) return [[]];
      if (/SELECT username, email, password FROM memberstab/.test(sql)) return [[current]];
      if (/SELECT uid FROM memberstab WHERE uid = /.test(sql)) return [[{ uid: 7 }]];
      if (/^\s*UPDATE/.test(sql)) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  };
  const router = loadRoute('routes/account.js', {
    'config/database.js': { pool },
    'middleware/auth.js': { memberAuth: (req, res, next) => next() },
    'services/schemaReadiness.js': { SCHEMA_REQUIREMENTS: { MEMBER_PROFILE: {} }, assertSchemaRequirements: async () => {} },
  });
  const handler = handlerFor(router, 'put', '/');

  const same = await call(handler, { password: STRONG, email: 'ana@example.test' }, { uid: 7 });
  assert.equal(same.statusCode, 400);
  assert.equal(same.body.error, SAME_AS_CURRENT_ERROR);

  const weak = await call(handler, { password: 'password1', email: 'ana@example.test' }, { uid: 7 });
  assert.equal(weak.statusCode, 400);
  assert.equal(writes.length, 0);

  const ok = await call(handler, { password: 'Fresh-Lagoon-88', email: 'ana@example.test' }, { uid: 7 });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(writes.length, 1);
});
