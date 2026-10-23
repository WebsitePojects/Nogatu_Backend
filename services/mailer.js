/**
 * Mailer service — transactional email delivery for the member portal.
 *
 * Currently used only for password-reset delivery. Two providers:
 *   - Resend (HTTPS API) when RESEND_API_KEY and MAIL_FROM are set. Preferred.
 *   - SMTP (nodemailer) when SMTP_HOST/USER/PASS and MAIL_FROM are set. Fallback.
 * Neither configured: sending is skipped with a single warning, so the reset endpoint keeps working.
 *
 * Nothing is created at import time: the SMTP transport is a lazy singleton and Resend is a plain
 * HTTPS call, so requiring this module has no side effects.
 *
 * Security: never log recipient addresses, tokens, reset links, or provider error messages (Resend
 * messages can echo addresses). Only the provider, an HTTP status and an error name are logged.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { buildPasswordResetEmail } = require('./emailTemplates/passwordReset');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10000;

// Injectable so unit tests can stub delivery without SMTP or network access.
let transportFactory = (options) => nodemailer.createTransport(options);
let fetchImpl = (...args) => fetch(...args);
let cachedTransport = null;
let warnedNotConfigured = false;

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * 'resend' | 'smtp' | null. Resend wins when both are configured, so adding the API key is enough
 * to switch providers without removing the SMTP settings.
 */
function resolveProvider() {
  if (!process.env.MAIL_FROM) return null;
  if (process.env.RESEND_API_KEY) return 'resend';
  if (isSmtpConfigured()) return 'smtp';
  return null;
}

function isMailerConfigured() {
  return resolveProvider() !== null;
}

/**
 * Build the nodemailer transport options from the environment.
 * Exposed for tests to assert the shape without opening a connection.
 */
function buildTransportOptions() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  return {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: SEND_TIMEOUT_MS,
  };
}

function getTransport() {
  if (!cachedTransport) {
    cachedTransport = transportFactory(buildTransportOptions());
  }
  return cachedTransport;
}

async function sendViaSmtp(message) {
  await getTransport().sendMail(message);
}

/**
 * One reset link = one email. The key is derived from the link (which carries the single-use token),
 * so if this request is ever retried Resend returns the first result instead of sending twice.
 */
function idempotencyKeyFor(resetUrl) {
  return `pwreset-${crypto.createHash('sha256').update(String(resetUrl)).digest('hex').slice(0, 40)}`;
}

async function sendViaResend(message, idempotencyKey) {
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errorName = 'unknown_error';
    try {
      const body = await response.json();
      if (body && typeof body.name === 'string') errorName = body.name;
    } catch {
      // Non-JSON error body: the status code alone is reported.
    }
    const err = new Error(`Resend rejected the email (HTTP ${response.status}, ${errorName})`);
    err.safeForLog = true;
    throw err;
  }
}

/**
 * Send a password-reset email. Never throws to the caller — on any failure it logs a safe summary
 * and returns { sent: false } so the calling HTTP handler keeps its generic, non-enumerating 200.
 *
 * @param {{ to: string, firstname?: string, resetUrl: string }} params
 * @returns {Promise<{ sent: boolean }>}
 */
async function sendPasswordResetEmail({ to, firstname, resetUrl } = {}) {
  const provider = resolveProvider();
  if (!provider) {
    if (!warnedNotConfigured) {
      console.warn('[Mailer] No email provider configured — password reset email skipped');
      warnedNotConfigured = true;
    }
    return { sent: false };
  }

  // Defensive: without a recipient or a link there is nothing to send.
  if (!to || !resetUrl) {
    return { sent: false };
  }

  try {
    const content = buildPasswordResetEmail({ firstname, resetUrl });
    const message = { from: process.env.MAIL_FROM, to, ...content };

    if (provider === 'resend') {
      await sendViaResend(message, idempotencyKeyFor(resetUrl));
    } else {
      await sendViaSmtp(message);
    }
    return { sent: true };
  } catch (err) {
    // Our own Resend error is known-safe; anything else (network, SMTP, timeout) is reduced to its
    // name and code (e.g. "TimeoutError", "Error EAUTH") so no address or link can reach the logs
    // through a library's error text.
    const summary = err && err.safeForLog
      ? err.message
      : [(err && err.name) || 'Error', err && err.code].filter(Boolean).join(' ');
    console.error(`[Mailer] ${provider} send failed:`, summary);
    return { sent: false };
  }
}

// --- Test hooks (not for production use) --------------------------------
function __setTransportFactoryForTests(factory) {
  transportFactory = factory || ((options) => nodemailer.createTransport(options));
  cachedTransport = null;
}

function __setFetchForTests(impl) {
  fetchImpl = impl || ((...args) => fetch(...args));
}

function __resetForTests() {
  cachedTransport = null;
  warnedNotConfigured = false;
  transportFactory = (options) => nodemailer.createTransport(options);
  fetchImpl = (...args) => fetch(...args);
}

module.exports = {
  isMailerConfigured,
  resolveProvider,
  buildTransportOptions,
  sendPasswordResetEmail,
  __setTransportFactoryForTests,
  __setFetchForTests,
  __resetForTests,
};
