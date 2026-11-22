/**
 * Member usernames as the PHP system stored them: no spaces, letters and digits only. Login and the
 * nogatu.store member check normalise what the member typed the same way, so both find the same account.
 */
function normalizeLegacyUsername(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9 ]/g, '');
}

module.exports = { normalizeLegacyUsername };
