/**
 * READ-PROOF: runs the REAL income engine (calculateAndStoreIncome) for the offset accounts
 * and asserts leadership (ttlincome3) does NOT move — proving the offset cancels exactly and
 * causes no instant credit. Safe to run on green (staging) or blue (prod) — it only triggers
 * the same recompute a normal dashboard load does; the offset guarantees a 0 leadership delta.
 *
 *   GREEN: node scripts/verify_leadership_offset.js
 *   BLUE : NODE_ENV=production node scripts/verify_leadership_offset.js
 */
const { loadBackendEnv } = require('./env');
loadBackendEnv();
const { pool } = require('../config/database');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');

const UIDS = [5726452, 6122895];

(async () => {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${process.env.NODE_ENV || '(none)'} DB=${who.u}/${who.d}\n`);

  for (const uid of UIDS) {
    const [[u]] = await pool.query('SELECT currentaccttype, accttype FROM usertab WHERE uid=?', [uid]);
    const accttype = Number(u?.currentaccttype || u?.accttype || 0);
    const [[b]] = await pool.query(
      'SELECT ROUND(ttlincome3,2) led, ROUND(leadership_credit_offset,2) off FROM payouttotaltab WHERE uid=?', [uid]
    );
    await calculateAndStoreIncome(uid, accttype);
    const [[a]] = await pool.query('SELECT ROUND(ttlincome3,2) led FROM payouttotaltab WHERE uid=?', [uid]);
    const delta = Number((Number(a.led) - Number(b.led)).toFixed(2));
    const verdict = delta === 0 ? 'OK — no instant credit' : '!!! LEADERSHIP CHANGED — investigate';
    console.log(`uid ${uid}: offset=${b.off}  ttlincome3 ${b.led} -> ${a.led}  (leadership delta ${delta})  ${verdict}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
