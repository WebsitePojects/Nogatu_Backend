const { pool } = require('../config/database');

function toNumber(value) {
  return Number(value || 0);
}

const EVENT_LABELS = {
  generated: 'Generated',
  release: 'Released',
  transfer: 'Transferred',
  admin_transfer: 'Admin Transfer',
  registration_use: 'Registration Used',
  'registration-used': 'Registration Used',
  upgrade_use: 'Upgrade Used',
  maintenance_use: 'Maintenance Used',
};

function pickName(username, fallback) {
  return username || fallback || 'Unknown';
}

function formatActivationHistoryEntry(row) {
  const eventType = row.event_type || null;
  const eventLabel = EVENT_LABELS[eventType] || (row.legacy_history ? 'Legacy History' : 'Code Event');
  const actorName = pickName(row.actor_username, row.actor_admin_name ? row.actor_admin_name : (row.actor_admin_id ? `Admin #${row.actor_admin_id}` : null));
  const fromName = pickName(row.from_username, row.from_uid ? `UID ${row.from_uid}` : null);
  const toName = pickName(row.to_username, row.to_uid ? `UID ${row.to_uid}` : null);

  let summary = row.legacy_history || 'Recorded code event.';
  if (eventType === 'generated') {
    summary = actorName !== 'Unknown'
      ? `${actorName} generated this code.`
      : toName !== 'Unknown'
        ? `Generated this code for ${toName}.`
        : 'Generated this code.';
  } else if (eventType === 'release') {
    summary = actorName !== 'Unknown'
      ? `${actorName} released this code.`
      : toName !== 'Unknown'
        ? `Released this code for ${toName}.`
        : 'Released this code.';
  } else if (eventType === 'transfer' || eventType === 'admin_transfer') {
    summary = actorName !== 'Unknown'
      ? `${actorName} transferred this code to ${toName}.`
      : fromName !== 'Unknown'
        ? `${fromName} transferred this code to ${toName}.`
        : `Transferred this code to ${toName}.`;
  } else if (eventType === 'registration_use' || eventType === 'registration-used') {
    summary = actorName !== 'Unknown'
      ? `${actorName} used this code for registration.`
      : toName !== 'Unknown'
        ? `${toName} used this code for registration.`
        : 'Used this code for registration.';
  } else if (eventType === 'upgrade_use') {
    summary = actorName !== 'Unknown'
      ? `${actorName} used this code for account upgrade.`
      : toName !== 'Unknown'
        ? `${toName} used this code for account upgrade.`
        : 'Used this code for account upgrade.';
  } else if (eventType === 'maintenance_use') {
    summary = actorName !== 'Unknown'
      ? `${actorName} used this code for maintenance.`
      : toName !== 'Unknown'
        ? `${toName} used this code for maintenance.`
        : 'Used this code for maintenance.';
  }

  return {
    code: row.code,
    eventType,
    eventLabel,
    summary,
    createdAt: row.created_at || row.datetransfer || row.dategen || null,
    actorUid: toNumber(row.actor_uid),
    actorAdminId: toNumber(row.actor_admin_id),
    actorUsername: row.actor_username || null,
    actorAdminName: row.actor_admin_name || null,
    fromUid: toNumber(row.from_uid),
    fromUsername: row.from_username || null,
    toUid: toNumber(row.to_uid),
    toUsername: row.to_username || null,
    registrationUid: toNumber(row.registration_uid),
    upgradeUid: toNumber(row.upgrade_uid),
    legacyHistory: row.legacy_history || null,
    processKey: row.process_key || row.processid || null,
    notes: row.notes || null,
  };
}

async function tableExists(tableName, conn = pool) {
  const [rows] = await conn.query(`SHOW TABLES LIKE ?`, [tableName]);
  return rows.length > 0;
}

async function listMemberActivationHistory(uid, page = 1, perPage = 20, conn = pool) {
  const currentPage = Math.max(1, toNumber(page) || 1);
  const size = Math.min(100, Math.max(1, toNumber(perPage) || 20));
  const offset = (currentPage - 1) * size;

  if (await tableExists('activation_code_usagetab', conn)) {
    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM activation_code_usagetab
       WHERE from_uid = ? OR to_uid = ? OR actor_uid = ? OR registration_uid = ? OR upgrade_uid = ?`,
      [uid, uid, uid, uid, uid]
    );

    const [rows] = await conn.query(
      `SELECT
          a.code, a.event_type, a.from_uid, a.to_uid, a.actor_uid, a.actor_admin_id,
          a.registration_uid, a.upgrade_uid, a.notes, a.process_key, a.created_at,
          fm.username AS from_username,
          tm.username AS to_username,
          am.username AS actor_username,
          aa.username AS actor_admin_name
       FROM activation_code_usagetab a
       LEFT JOIN memberstab fm ON fm.uid = a.from_uid
       LEFT JOIN memberstab tm ON tm.uid = a.to_uid
       LEFT JOIN memberstab am ON am.uid = a.actor_uid
       LEFT JOIN accesstab aa ON aa.id = a.actor_admin_id
       WHERE a.from_uid = ? OR a.to_uid = ? OR a.actor_uid = ? OR a.registration_uid = ? OR a.upgrade_uid = ?
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?, ?`,
      [uid, uid, uid, uid, uid, offset, size]
    );

    return {
      rows: rows.map(formatActivationHistoryEntry),
      total: toNumber(countRows[0]?.total),
      page: currentPage,
      totalPages: Math.max(1, Math.ceil(toNumber(countRows[0]?.total) / size)),
    };
  }

  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS total
     FROM codehistorytab h
     INNER JOIN codestab c ON c.code = h.code
     WHERE c.uid = ?`,
    [uid]
  );
  const [rows] = await conn.query(
    `SELECT h.code, h.history AS legacy_history, h.datetransfer, h.processid
     FROM codehistorytab h
     INNER JOIN codestab c ON c.code = h.code
     WHERE c.uid = ?
     ORDER BY h.datetransfer DESC, h.id DESC
     LIMIT ?, ?`,
    [uid, offset, size]
  );

  return {
    rows: rows.map(formatActivationHistoryEntry),
    total: toNumber(countRows[0]?.total),
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(toNumber(countRows[0]?.total) / size)),
  };
}

async function listAdminActivationHistory({ page = 1, perPage = 30, codeQuery = '' } = {}, conn = pool) {
  const currentPage = Math.max(1, toNumber(page) || 1);
  const size = Math.min(100, Math.max(1, toNumber(perPage) || 30));
  const offset = (currentPage - 1) * size;
  const q = String(codeQuery || '').trim();

  if (await tableExists('activation_code_usagetab', conn)) {
    const whereSql = q ? 'WHERE a.code LIKE ?' : '';
    const whereParams = q ? [`%${q}%`] : [];

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM activation_code_usagetab a
       ${whereSql}`,
      whereParams
    );
    const [rows] = await conn.query(
      `SELECT
          a.code, a.event_type, a.from_uid, a.to_uid, a.actor_uid, a.actor_admin_id,
          a.registration_uid, a.upgrade_uid, a.notes, a.process_key, a.created_at,
          fm.username AS from_username,
          tm.username AS to_username,
          am.username AS actor_username,
          aa.username AS actor_admin_name
       FROM activation_code_usagetab a
       LEFT JOIN memberstab fm ON fm.uid = a.from_uid
       LEFT JOIN memberstab tm ON tm.uid = a.to_uid
       LEFT JOIN memberstab am ON am.uid = a.actor_uid
       LEFT JOIN accesstab aa ON aa.id = a.actor_admin_id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?, ?`,
      [...whereParams, offset, size]
    );

    return {
      rows: rows.map(formatActivationHistoryEntry),
      total: toNumber(countRows[0]?.total),
      page: currentPage,
      totalPages: Math.max(1, Math.ceil(toNumber(countRows[0]?.total) / size)),
    };
  }

  const whereSql = q ? 'WHERE h.code LIKE ?' : '';
  const whereParams = q ? [`%${q}%`] : [];
  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS total
     FROM codehistorytab h
     ${whereSql}`,
    whereParams
  );
  const [rows] = await conn.query(
    `SELECT h.code, h.history AS legacy_history, h.datetransfer, h.processid
     FROM codehistorytab h
     ${whereSql}
     ORDER BY h.datetransfer DESC, h.id DESC
     LIMIT ?, ?`,
    [...whereParams, offset, size]
  );

  return {
    rows: rows.map(formatActivationHistoryEntry),
    total: toNumber(countRows[0]?.total),
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(toNumber(countRows[0]?.total) / size)),
  };
}

module.exports = {
  formatActivationHistoryEntry,
  listMemberActivationHistory,
  listAdminActivationHistory,
};
