/**
 * Mailer service — transactional email transport for the member portal.
 *
 * Currently used only for password-reset delivery. The transport is created
 * lazily as a process-wide singleton so importing this module is side-effect
 * free (no SMTP connection until the first send).
 *
 * Security: never log recipient addresses, tokens, or any PII. Only error
 * messages (err.message) are logged, never the error stack or the payload.
 */
const nodemailer = require('nodemailer');

// Injectable transport factory so unit tests can stub nodemailer without a
// real SMTP server. Defaults to the real nodemailer.createTransport.
let transportFactory = (options) => nodemailer.createTransport(options);
let cachedTransport = null;
let warnedNotConfigured = false;

/**
 * True iff every SMTP setting required to send mail is present in the env.
 */
function isMailerConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.MAIL_FROM
  );
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
    connectionTimeout: 10000,
  };
}

/**
 * Lazily create (and cache) the singleton transport.
 */
function getTransport() {
  if (!cachedTransport) {
    cachedTransport = transportFactory(buildTransportOptions());
  }
  return cachedTransport;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send a password-reset email. Never throws to the caller — on any failure it
 * logs err.message (message only) and returns { sent: false } so the calling
 * HTTP handler can keep its generic, non-enumerating 200 response.
 *
 * @param {{ to: string, firstname?: string, resetUrl: string }} params
 * @returns {Promise<{ sent: boolean }>}
 */
async function sendPasswordResetEmail({ to, firstname, resetUrl } = {}) {
  if (!isMailerConfigured()) {
    if (!warnedNotConfigured) {
      console.warn('[Mailer] SMTP not configured — password reset email skipped');
      warnedNotConfigured = true;
    }
    return { sent: false };
  }

  // Defensive: without a recipient or a link there is nothing to send.
  if (!to || !resetUrl) {
    return { sent: false };
  }

  try {
    const name = firstname ? String(firstname).trim() : '';
    const greeting = name ? `Hi ${name},` : 'Hi,';

    const text = [
      greeting,
      '',
      'We received a request to reset your NOGATU Alliance portal password.',
      '',
      `Reset your password here: ${resetUrl}`,
      '',
      'This link expires in 15 minutes. If you did not request this, ignore this email.',
      '',
      '— NOGATU Alliance',
    ].join('\n');

    const safeGreeting = escapeHtml(greeting);
    const safeUrl = escapeHtml(resetUrl);
    const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;">
            <tr><td style="font-size:18px;font-weight:bold;color:#166534;padding-bottom:16px;">NOGATU Alliance</td></tr>
            <tr><td style="font-size:15px;padding-bottom:12px;">${safeGreeting}</td></tr>
            <tr><td style="font-size:14px;line-height:1.5;padding-bottom:20px;">We received a request to reset your NOGATU Alliance portal password.</td></tr>
            <tr>
              <td style="padding-bottom:20px;">
                <a href="${safeUrl}" style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 24px;border-radius:6px;">Reset password</a>
              </td>
            </tr>
            <tr><td style="font-size:13px;line-height:1.5;color:#6b7280;padding-bottom:8px;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#166534;word-break:break-all;">${safeUrl}</a></td></tr>
            <tr><td style="font-size:13px;line-height:1.5;color:#6b7280;">This link expires in 15 minutes. If you did not request this, ignore this email.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    await getTransport().sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject: 'Reset your NOGATU Alliance password',
      text,
      html,
    });

    return { sent: true };
  } catch (err) {
    // message only — never the recipient address, token, or stack.
    console.error('[Mailer] send failed:', err.message);
    return { sent: false };
  }
}

// --- Test hooks (not for production use) --------------------------------
// Allow unit tests to inject a stub transport factory and reset the module's
// cached singleton / warn-once state between cases.
function __setTransportFactoryForTests(factory) {
  transportFactory = factory || ((options) => nodemailer.createTransport(options));
  cachedTransport = null;
}

function __resetForTests() {
  cachedTransport = null;
  warnedNotConfigured = false;
  transportFactory = (options) => nodemailer.createTransport(options);
}

module.exports = {
  isMailerConfigured,
  buildTransportOptions,
  sendPasswordResetEmail,
  __setTransportFactoryForTests,
  __resetForTests,
};
