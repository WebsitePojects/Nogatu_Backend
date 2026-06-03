const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

async function main() {
  loadBackendEnv();
  const db = getDbConfig();
  const conn = await mysql.createConnection(db);

  try {
    await assertSchemaRequirements(SCHEMA_REQUIREMENTS.READINESS, 'Backend readiness smoke', conn);

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
