const { pool } = require('../config/database');
const { requestId: makeRequestId } = require('../utils/security');

function jsonOrNull(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

async function writeAuditLog(connOrOptions, maybeOptions) {
  const conn = maybeOptions ? connOrOptions : pool;
  const options = maybeOptions || connOrOptions || {};

  const req = options.req;
  const requestId = options.requestId || req?.requestId || makeRequestId(req);

  try {
    await conn.query(
      `INSERT INTO audit_logtab
       (actor_uid, actor_role, action, target_uid, target_table, target_id,
        before_state, after_state, ip_address, user_agent, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        options.actorUid || null,
        options.actorRole || 'system',
        options.action,
        options.targetUid || null,
        options.targetTable || null,
        options.targetId || null,
        jsonOrNull(options.beforeState),
        jsonOrNull(options.afterState),
        req?.ip || options.ipAddress || null,
        req?.headers?.['user-agent'] || options.userAgent || null,
        requestId,
      ]
    );
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.warn('[Audit] audit_logtab missing; run npm run db:migrate to enable audit persistence.');
      return;
    }
    throw error;
  }
}

module.exports = { writeAuditLog };
