// GET /api/registration/available-position used to return 500 when placementUid was
// missing or junk (Number(undefined) = NaN reached the query). It must be a 400 and
// must not touch the service; a valid uid still works.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

function loadRouter(calls) {
  const routePath = path.join(repoRoot, 'routes', 'registration.js');
  const servicePath = path.join(repoRoot, 'services', 'registration.js');
  const authPath = path.join(repoRoot, 'middleware', 'auth.js');
  const saved = [servicePath, authPath].map((p) => [p, require.cache[p]]);
  const realService = require(servicePath);
  require.cache[servicePath] = {
    id: servicePath, filename: servicePath, loaded: true,
    exports: { ...realService, getAvailablePosition: async (uid) => { calls.push(uid); return 2; } },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: new Proxy({}, { get: () => (req, res, next) => next() }),
  };
  delete require.cache[routePath];
  try {
    return require(routePath);
  } finally {
    delete require.cache[routePath];
    for (const [p, c] of saved) { if (c) require.cache[p] = c; else delete require.cache[p]; }
  }
}

function handlersFor(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/available-position' && l.route.methods.get);
  assert.ok(layer, 'route exists');
  return layer.route.stack.map((s) => s.handle);
}

async function call(query) {
  const calls = [];
  const handlers = handlersFor(loadRouter(calls));
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const req = { query, session: { uid: 1 } };
  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { res, calls };
}

for (const [label, query] of [
  ['missing', {}],
  ['empty', { placementUid: '' }],
  ['text', { placementUid: 'abc' }],
  ['zero', { placementUid: '0' }],
  ['negative', { placementUid: '-5' }],
  ['decimal', { placementUid: '1.5' }],
  ['array', { placementUid: ['1', '2'] }],
]) {
  test('placementUid ' + label + ' is a 400 and never reaches the service', async () => {
    const { res, calls } = await call(query);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
}

test('a valid placementUid still returns the position', async () => {
  const { res, calls } = await call({ placementUid: '4660003' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { position: 2 });
  assert.deepEqual(calls, [4660003]);
});
