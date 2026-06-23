/**
 * READ-ONLY. Proves Rosalie (Lhee143, uid 5726452) earns 5% leadership on her
 * downline's pairing — including Elmer143 (her level-1 sponsor downline).
 * Compares the live engine entitlement vs the stored ttlincome3 (monotonic credited).
 * Run on BLUE (prod):  NODE_ENV=production node scripts/audit_leadership_rosalie.js
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const { getLeadershipTraceability } = require('../services/income/leadership');

const ROSALIE = 5726452;

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}`);

  const trace = await getLeadershipTraceability(ROSALIE);
  const [[stored]] = await pool.query(
    'SELECT ROUND(ttlincome3,2) led FROM payouttotaltab WHERE uid=?', [ROSALIE]
  );
  const engine = Number(trace.totalBonus || 0);
  const credited = Number(stored?.led || 0);

  console.log('\n=== Rosalie (Lhee143) leadership ===');
  console.log('engine entitlement (current) :', engine.toFixed(2));
  console.log('stored ttlincome3 (credited) :', credited.toFixed(2));
  console.log('delta owed (credits on next portal load):', Math.max(0, engine - credited).toFixed(2));
  console.log('byLevel:', JSON.stringify(trace.byLevel));

  console.log('\n=== per-source (each downline that pays her leadership) ===');
  trace.rows
    .sort((a, b) => b.leadershipBonus - a.leadershipBonus)
    .forEach((r) => console.log(
      `L${r.level}  ${r.username}  pairing=${r.pairingIncome.toFixed(2)}  x${r.ratePercent}%  => ${r.leadershipBonus.toFixed(2)}`
    ));

  const elmer = trace.rows.find((r) => r.username === 'Elmer143');
  console.log('\nElmer143 contribution to Rosalie:',
    elmer ? `${elmer.leadershipBonus.toFixed(2)} (5% of his ${elmer.pairingIncome.toFixed(2)} pairing)` : 'NOT FOUND');

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
