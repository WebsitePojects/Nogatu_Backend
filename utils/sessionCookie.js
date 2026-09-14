function parseBooleanEnv(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for SESSION_COOKIE_SECURE: ${value}`);
}

function normalizeSameSite(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['lax', 'strict', 'none'].includes(normalized)) return normalized;
  throw new Error(`Invalid SESSION_COOKIE_SAMESITE value: ${value}`);
}

function resolveSessionCookieConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').trim();
  const explicitSecure = parseBooleanEnv(env.SESSION_COOKIE_SECURE);
  const explicitSameSite = normalizeSameSite(env.SESSION_COOKIE_SAMESITE);

  const secure = explicitSecure !== undefined
    ? explicitSecure
    : nodeEnv === 'production';

  const sameSite = explicitSameSite || (nodeEnv === 'production' ? 'none' : 'lax');

  if (sameSite === 'none' && secure !== true) {
    throw new Error('SESSION_COOKIE_SAMESITE=none requires SESSION_COOKIE_SECURE=true');
  }

  return {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure,
    sameSite,
  };
}

module.exports = {
  resolveSessionCookieConfig,
};
