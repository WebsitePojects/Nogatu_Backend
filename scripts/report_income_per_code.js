/**
 * READ-ONLY report: income triggered per activation code (Sir Dino item 8), as .xlsx.
 * Runs 3 SELECTs on one connection inside a READ ONLY transaction; writes nothing to the DB.
 *
 * Usage:
 *   GREEN:  cd /var/www/nogatu-green && node scripts/report_income_per_code.js --from 2026-06 --to 2026-11 --out /root/income_per_code_green.xlsx
 *   BLUE:   cd /var/www/nogatu && NODE_ENV=production node scripts/report_income_per_code.js --from 2026-06 --to 2026-11 --out /root/income_per_code.xlsx
 */
const path = require('path');
const { loadBackendEnv, getDbConfig } = require('./env');

function parseArgs(argv) {
  const out = { from: null, to: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from' && argv[i + 1]) out.from = argv[++i];
    else if (argv[i] === '--to' && argv[i + 1]) out.to = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i];
  }
  return out;
}

async function main() {
  loadBackendEnv(); // must run before anything requires config/database
  const cfg = getDbConfig();
  console.log(`env=${process.env.NODE_ENV || ''} DB=${cfg.user}@${cfg.host}/${cfg.database}`);

  const args = parseArgs(process.argv.slice(2));
  const {
    resolveRange, loadSnapshot, computeIncomePerCode, buildIncomePerCodeWorkbook,
  } = require('../services/incomePerCode');
  const range = resolveRange(args); // throws on a bad range before touching the DB
  const outFile = path.resolve(args.out || `Nogatu_Income_Per_Code_${range.from}_to_${range.to}.xlsx`);

  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(cfg);
  let snapshot;
  try {
    // One consistent snapshot; the server refuses any write inside a READ ONLY transaction.
    await conn.query('START TRANSACTION READ ONLY');
    snapshot = await loadSnapshot(conn);
    await conn.query('COMMIT');
  } finally {
    await conn.end();
  }

  const started = Date.now();
  const report = await computeIncomePerCode(range, snapshot);
  console.log(`codes=${report.rows.length} uplines=${report.check.owners} locked=${report.check.lockedOwners} `
    + `engineSMB=${report.check.engineTotal} attributedSMB=${report.check.attributedTotal} `
    + `difference=${report.check.difference} computeMs=${Date.now() - started}`);
  if (report.check.difference !== 0) {
    console.error('STOP: SMB attribution does not add up to the engine total. Report not written.');
    process.exit(2);
  }
  await buildIncomePerCodeWorkbook(report).xlsx.writeFile(outFile);
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
