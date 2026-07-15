const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMailerConfigured,
  buildTransportOptions,
  sendPasswordResetEmail,
  __setTransportFactoryForTests,
  __resetForTests,
} = require('../../services/mailer');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

function clearSmtpEnv() {
  for (const key of SMTP_KEYS) delete process.env[key];
}

function setSmtpEnv(overrides = {}) {
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_USER = 'mailer@example.test';
  process.env.SMTP_PASS = 'secret';
  process.env.MAIL_FROM = 'NOGATU Alliance <no-reply@example.test>';
  Object.assign(process.env, overrides);
}

test.beforeEach(() => {
  clearSmtpEnv();
  __resetForTests();
});

test.after(() => {
  clearSmtpEnv();
  __resetForTests();
});

test('unconfigured mailer reports not configured and skips send without throwing', async () => {
  assert.equal(isMailerConfigured(), false);
  const result = await sendPasswordResetEmail({
    to: 'member@example.test',
    firstname: 'Ana',
    resetUrl: 'https://portal.example.test/portal/reset-password?token=abc',
  });
  assert.deepEqual(result, { sent: false });
});

test('transport options derive port/secure from env (defaults 587 + STARTTLS)', () => {
  setSmtpEnv();
  const options = buildTransportOptions();
  assert.equal(options.host, 'smtp.example.test');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.auth.user, 'mailer@example.test');
  assert.equal(options.auth.pass, 'secret');
});

test('port 465 or SMTP_SECURE=true forces implicit TLS', () => {
  setSmtpEnv({ SMTP_PORT: '465' });
  assert.equal(buildTransportOptions().secure, true);
  setSmtpEnv({ SMTP_PORT: '587', SMTP_SECURE: 'true' });
  assert.equal(buildTransportOptions().secure, true);
});

test('configured mailer sends via the transport with from/to/subject and the reset link', async () => {
  setSmtpEnv();
  const sent = [];
  __setTransportFactoryForTests(() => ({
    sendMail: async (message) => { sent.push(message); },
  }));

  const result = await sendPasswordResetEmail({
    to: 'member@example.test',
    firstname: 'Ana',
    resetUrl: 'https://portal.example.test/portal/reset-password?token=abc123',
  });

  assert.deepEqual(result, { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, process.env.MAIL_FROM);
  assert.equal(sent[0].to, 'member@example.test');
  assert.match(sent[0].subject, /reset/i);
  assert.ok(sent[0].text.includes('https://portal.example.test/portal/reset-password?token=abc123'));
  assert.ok(sent[0].html.includes('https://portal.example.test/portal/reset-password?token=abc123'));
});

test('transport send failure is swallowed and reported as sent:false', async () => {
  setSmtpEnv();
  __setTransportFactoryForTests(() => ({
    sendMail: async () => { throw new Error('connect ETIMEDOUT'); },
  }));
  const result = await sendPasswordResetEmail({
    to: 'member@example.test',
    resetUrl: 'https://portal.example.test/portal/reset-password?token=abc',
  });
  assert.deepEqual(result, { sent: false });
});

test('missing recipient or reset URL skips the transport entirely', async () => {
  setSmtpEnv();
  let calls = 0;
  __setTransportFactoryForTests(() => ({
    sendMail: async () => { calls += 1; },
  }));
  assert.deepEqual(await sendPasswordResetEmail({ to: '', resetUrl: 'https://x.test/r?token=a' }), { sent: false });
  assert.deepEqual(await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: '' }), { sent: false });
  assert.equal(calls, 0);
});

test('html body escapes markup in the greeting name', async () => {
  setSmtpEnv();
  const sent = [];
  __setTransportFactoryForTests(() => ({
    sendMail: async (message) => { sent.push(message); },
  }));
  await sendPasswordResetEmail({
    to: 'member@example.test',
    firstname: '<script>alert(1)</script>',
    resetUrl: 'https://portal.example.test/portal/reset-password?token=abc',
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].html.includes('<script>'));
  assert.ok(sent[0].html.includes('&lt;script&gt;'));
});
