const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

const REQUIRED_TABLES = [
  'usertab',
  'memberstab',
  'payouttotaltab',
  'payouthistorytab',
  'binary_tree_closuretab',
  'binary_point_eventstab',
  'income_eventstab',
  'encashmentstab',
  'rank_definitionstab',
  'rank_point_consumptiontab',
  'audit_logtab',
  'support_ticketstab',
  'password_reset_tokenstab',
];

async function main() {
  loadBackendEnv();
  const db = getDbConfig();
  const conn = await mysql.createConnection(db);

  try {
    for (const table of REQUIRED_TABLES) {
      const [rows] = await conn.query('SHOW TABLES LIKE ?', [table]);
      if (rows.length === 0) throw new Error(`Required table missing: ${table}`);
    }

    const [publicUid] = await conn.query("SHOW COLUMNS FROM usertab LIKE 'public_uid'");
    const [slug] = await conn.query("SHOW COLUMNS FROM usertab LIKE 'referral_slug'");
    if (publicUid.length === 0 || slug.length === 0) {
      throw new Error('usertab public_uid/referral_slug columns are missing');
    }

    const [rankRows] = await conn.query('SELECT COUNT(*) AS total FROM rank_definitionstab WHERE is_active = 1');
    if (Number(rankRows[0].total) < 10) {
      throw new Error('Rank definitions were not seeded completely');
    }

    console.log(`[smoke] schema smoke passed on ${db.database}@${db.host}`);
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('[smoke] failed:', error.message);
  process.exit(1);
});
