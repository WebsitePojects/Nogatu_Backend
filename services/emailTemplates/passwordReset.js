/**
 * Password-reset email content (subject, plain text, HTML).
 *
 * Kept apart from the transport so the wording and branding can change without touching how mail
 * is sent. The HTML is table-based with inline styles because most mail clients (Gmail, Outlook,
 * Yahoo) strip <style> blocks and ignore modern layout. Every interpolated value is escaped: the
 * first name is member-entered, and the link must not be able to break out of its attribute.
 */
const BRAND = {
  name: 'NOGATU Alliance',
  gold: '#D4AF37',
  ink: '#111827',
  muted: '#6B7280',
  page: '#F3F4F6',
  card: '#FFFFFF',
  rule: '#E5E7EB',
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {{ firstname?: string, resetUrl: string, expiresMinutes?: number }} params
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildPasswordResetEmail({ firstname, resetUrl, expiresMinutes = 15 } = {}) {
  const name = firstname ? String(firstname).trim() : '';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const expiry = `This link works once and expires in ${expiresMinutes} minutes.`;
  const subject = `Reset your ${BRAND.name} password`;

  const text = [
    greeting,
    '',
    `We received a request to reset the password of your ${BRAND.name} portal account.`,
    '',
    'Open this link to choose a new password:',
    resetUrl,
    '',
    expiry,
    '',
    'If you did not ask for this, you can ignore this email. Your password stays the same.',
    'Never share this link. NOGATU staff will never ask you for it.',
    '',
    `${BRAND.name}`,
  ].join('\n');

  const g = escapeHtml(greeting);
  const url = escapeHtml(resetUrl);
  const preheader = escapeHtml(`Reset your password. ${expiry}`);

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.page};font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.page};">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.card};border-radius:12px;overflow:hidden;border:1px solid ${BRAND.rule};">
            <tr>
              <td style="background:${BRAND.ink};padding:22px 32px;">
                <span style="font-size:20px;font-weight:bold;letter-spacing:1px;color:${BRAND.gold};">NOGATU</span>
                <span style="font-size:20px;font-weight:bold;letter-spacing:1px;color:#FFFFFF;"> ALLIANCE</span>
              </td>
            </tr>
            <tr><td style="height:4px;background:${BRAND.gold};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;color:${BRAND.ink};">Reset your password</h1>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;">${g}</p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;">We received a request to reset the password of your ${BRAND.name} portal account. Tap the button below to choose a new one.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background:${BRAND.gold};">
                      <a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:bold;color:${BRAND.ink};text-decoration:none;border-radius:8px;">Choose a new password</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0;padding:12px 16px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;font-size:14px;line-height:1.5;color:#92400E;">${escapeHtml(expiry)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">If the button does not work, copy this link into your browser:</p>
                <p style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${url}" target="_blank" rel="noopener" style="color:#7A5F12;">${url}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid ${BRAND.rule};">
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">If you did not ask for this, you can ignore this email. Your password stays the same.</p>
                <p style="margin:0;font-size:13px;line-height:1.5;color:${BRAND.muted};">Never share this link. NOGATU staff will never ask you for it.</p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:12px;color:${BRAND.muted};">&copy; ${BRAND.name}. This is an automated message; replies are not monitored.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

module.exports = { buildPasswordResetEmail, escapeHtml };
