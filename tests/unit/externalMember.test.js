// nogatu.store member check: only the right username + password passes; the key is required; nothing leaks.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createExternalMemberRouter } = require('../../routes/externalMember');

const ROWS = {
  juan01: { uid: 10, public_uid: 'NA-0010', account_status: null, username: 'juan01', password: bcrypt.hashSync('Right#Pass1', 4) },
  oldphp: { uid: 11, public_uid: null, account_status: 'Active', username: 'oldphp', password: crypto.createHash('md5').update('legacy123').digest('hex') },
  frozen1: { uid: 12, public_uid: 'NA-0012', account_status: 'frozen', username: 'frozen1', password: bcrypt.hashSync('Frozen#1', 4) },
};
const pool = { query: async (sql, [username]) => [[ROWS[username]].filter(Boolean)] };

let server;
let base;
let key = 'bridge-key';
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/external', createExternalMemberRouter({ pool, getApiKey: () => key }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/external/member/verify`;
});
test.after(() => server.close());

const verify = (body, apiKey = 'bridge-key') => fetch(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

test('the right credentials pass and return only who the member is', async () => {
  const res = await verify({ username: 'juan01', password: 'Right#Pass1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { verified: true, uid: 'NA-0010', username: 'juan01', account_status: 'active' });
  assert.equal(JSON.stringify(res.body).includes('Right#Pass1'), false);
  assert.equal(JSON.stringify(res.body).includes('$2'), false, 'no hash in the answer');
});

test('PHP-era MD5 passwords still work, as at login; status is reported for nogatu.store to judge', async () => {
  assert.equal((await verify({ username: 'oldphp', password: 'legacy123' })).body.data.uid, '11');
  assert.equal((await verify({ username: 'frozen1', password: 'Frozen#1' })).body.data.account_status, 'frozen');
});

test('a wrong password and an unknown username get the same 401', async () => {
  const wrong = await verify({ username: 'juan01', password: 'nope' });
  const unknown = await verify({ username: 'nobody99', password: 'nope' });
  assert.deepEqual([wrong.status, unknown.status], [401, 401]);
  assert.deepEqual(wrong.body, unknown.body);
});

test('no key, a wrong key, or no key configured are refused before any lookup', async () => {
  assert.equal((await verify({ username: 'juan01', password: 'Right#Pass1' }, null)).status, 403);
  assert.equal((await verify({ username: 'juan01', password: 'Right#Pass1' }, 'guess')).status, 403);
  key = '';
  assert.equal((await verify({ username: 'juan01', password: 'Right#Pass1' })).status, 503);
  key = 'bridge-key';
});

test('five wrong passwords lock that username for the window', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await verify({ username: 'frozen1', password: `x${i}` })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});
