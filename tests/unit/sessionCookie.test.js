const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSessionCookieConfig } = require('../../utils/sessionCookie');

test('production defaults to cross-site secure cookies', () => {
  const cookie = resolveSessionCookieConfig({ NODE_ENV: 'production' });

  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'none');
  assert.equal(cookie.httpOnly, true);
});

test('local development keeps lax cookies by default', () => {
  const cookie = resolveSessionCookieConfig({ NODE_ENV: 'development' });

  assert.equal(cookie.secure, false);
  assert.equal(cookie.sameSite, 'lax');
});

test('green staging can opt into cross-site cookies without changing NODE_ENV', () => {
  const cookie = resolveSessionCookieConfig({
    NODE_ENV: 'development',
    SESSION_COOKIE_SECURE: 'true',
    SESSION_COOKIE_SAMESITE: 'none',
  });

  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'none');
});

test('SameSite=None fails closed unless the cookie is secure', () => {
  assert.throws(
    () => resolveSessionCookieConfig({
      NODE_ENV: 'development',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_COOKIE_SAMESITE: 'none',
    }),
    /requires SESSION_COOKIE_SECURE=true/
  );
});
