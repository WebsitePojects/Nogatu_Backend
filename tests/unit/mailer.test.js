const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMailerConfigured,
  resolveProvider,
  buildTransportOptions,
  sendPasswordResetEmail,
  __setTransportFactoryForTests,
  __setFetchForTests,
  __resetForTests,
} = require('../../services/mailer');
const { buildPasswordResetEmail } = require('../../services/emailTemplates/passwordReset');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'RESEND_API_KEY'];

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

// --- Resend provider ------------------------------------------------------

const RESET_URL = 'https://portal.example.test/portal/reset-password?token=tok_abc123';

function setResendEnv(overrides = {}) {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'NOGATU Alliance <no-reply@example.test>';
  Object.assign(process.env, overrides);
}

function stubFetch(response = { ok: true, status: 200, json: async () => ({ id: 'email_1' }) }) {
  const calls = [];
  __setFetchForTests(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (response instanceof Error) throw response;
    return response;
  });
  return calls;
}

function captureConsoleError() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

test('provider: Resend needs both RESEND_API_KEY and MAIL_FROM', () => {
  process.env.RESEND_API_KEY = 're_test_key';
  assert.equal(resolveProvider(), null);
  assert.equal(isMailerConfigured(), false);
  process.env.MAIL_FROM = 'NOGATU Alliance <no-reply@example.test>';
  assert.equal(resolveProvider(), 'resend');
});

test('provider: Resend wins over SMTP when both are configured, and SMTP is never touched', async () => {
  setSmtpEnv();
  setResendEnv();
  let smtpCalls = 0;
  __setTransportFactoryForTests(() => ({ sendMail: async () => { smtpCalls += 1; } }));
  const calls = stubFetch();

  const result = await sendPasswordResetEmail({ to: 'member@example.test', firstname: 'Ana', resetUrl: RESET_URL });

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(smtpCalls, 0);
});

test('Resend request: endpoint, auth, recipient array, branded HTML and text both carry the link', async () => {
  setResendEnv();
  const calls = stubFetch();

  await sendPasswordResetEmail({ to: 'member@example.test', firstname: 'Ana', resetUrl: RESET_URL });

  const [call] = calls;
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer re_test_key');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.ok(call.init.signal, 'request must carry a timeout signal');
  assert.equal(call.body.from, 'NOGATU Alliance <no-reply@example.test>');
  assert.deepEqual(call.body.to, ['member@example.test']);
  assert.match(call.body.subject, /reset/i);
  assert.ok(call.body.html.includes(RESET_URL));
  assert.ok(call.body.text.includes(RESET_URL));
  assert.ok(call.body.html.includes('Hi Ana,'));
  assert.ok(call.body.html.includes('NOGATU'));
});

test('Resend idempotency key: stable for the same link, different for a different link, never the raw token', async () => {
  setResendEnv();
  const calls = stubFetch();

  await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
  await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
  await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: `${RESET_URL}x` });

  const keys = calls.map((c) => c.init.headers['Idempotency-Key']);
  assert.ok(keys[0] && keys[0].startsWith('pwreset-'));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.ok(!keys[0].includes('tok_abc123'), 'the key must not expose the reset token');
});

test('Resend rejection returns sent:false and logs status + error name, never the address, link or provider message', async () => {
  setResendEnv();
  stubFetch({
    ok: false,
    status: 403,
    json: async () => ({ name: 'validation_error', message: 'You can only send testing emails to your own email address (member@example.test).' }),
  });
  const log = captureConsoleError();
  let result;
  try {
    result = await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
  } finally {
    log.restore();
  }

  assert.deepEqual(result, { sent: false });
  const output = log.lines.join('\n');
  assert.match(output, /HTTP 403/);
  assert.match(output, /validation_error/);
  assert.ok(!output.includes('member@example.test'), 'recipient leaked into logs');
  assert.ok(!output.includes('tok_abc123'), 'reset token leaked into logs');
});

test('Resend network failure or timeout returns sent:false and logs only the error name', async () => {
  setResendEnv();
  const timeout = new Error(`The operation was aborted for ${RESET_URL} to member@example.test`);
  timeout.name = 'TimeoutError';
  stubFetch(timeout);
  const log = captureConsoleError();
  let result;
  try {
    result = await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
  } finally {
    log.restore();
  }

  assert.deepEqual(result, { sent: false });
  const output = log.lines.join('\n');
  assert.match(output, /TimeoutError/);
  assert.ok(!output.includes('member@example.test'));
  assert.ok(!output.includes('tok_abc123'));
});

test('unconfigured mailer warns once, not on every request', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
    await sendPasswordResetEmail({ to: 'member@example.test', resetUrl: RESET_URL });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});

// --- Template -------------------------------------------------------------

test('template: link with quote characters cannot break out of the href attribute', () => {
  const { html } = buildPasswordResetEmail({ resetUrl: 'https://x.test/r?token=a"><img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('"><img'));
  assert.ok(html.includes('&quot;&gt;&lt;img'));
});

test('template: states single use and the expiry, and greets without a name when none is given', () => {
  const { subject, text, html } = buildPasswordResetEmail({ resetUrl: RESET_URL, expiresMinutes: 15 });
  assert.equal(subject, 'Reset your NOGATU Alliance password');
  assert.match(text, /^Hi,$/m);
  assert.match(text, /works once and expires in 15 minutes/);
  assert.match(html, /works once and expires in 15 minutes/);
});
