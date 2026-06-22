/**
 * settle_unilevel_month.js — monthly unilevel settlement (run at month rollover).
 *
 * Business rule (#7): unilevel is monthly. At month-end, for each member:
 *   - prev-month UNILEVEL maintenance (bucket='unilevel') >= 200  -> CREDIT the unilevel
 *     income to the wallet, then reset (maintenance window resets naturally next month).
 *   - < 200 -> VOID (nothing credited).
 *
 * It reuses the EXACT proven credit path used on dashboard/e-wallet view:
 *   getUnilevel(uid)            -> prev-month unilevel WITH the >=200 maintenance gate +
 *                                  the once-per-month idempotency guard (incometransdatetab
 *                                  incometype=4) baked in. Returns 0 if not eligible or
 *                                  already settled this month.
 *   applyLifetimeIncomeCeiling  -> respects the package lifetime ceiling (e.g. Bronze 40k).
 *   insertIncome                -> the audited payouthistorytab + payouttotaltab credit.
 *
 * Idempotent + forward-only: re-running for an already-settled period is a no-op (the
 * incometype=4 guard), and it only ever settles the PREVIOUS month. Per-uid GET_LOCK
 * mirrors the on-view orchestrator so a concurrent dashboard load can't double-credit.
 *
 * Usage:
 *   NODE_ENV=production node scripts/settle_unilevel_month.js --dry-run [--limit N]
 *   NODE_ENV=production node scripts/settle_unilevel_month.js          [--limit N]   (commits)
 */
const { loadBackendEnv, getDbConfig } = require('./env');

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const envFile = loadBackendEnv();
  const db = getDbConfig();
  console.log(`env=${envFile} DB=${db.user}@${db.host}/${db.database}`);

  const dryRun = flag('dry-run');
  const limit = Math.max(0, Number(arg('limit')) || 0);

  const { pool } = require('../config/database');
  const { getUnilevel, checkLastMaintenance, checkUnilevelTransDate, isUnilevelReleaseWindow, updateIncomeTransDate, hasUnilevelCreditedThisMonth } = require('../services/income/unilevel');
  const { insertIncome } = require('../services/income/insertIncome');
  const { applyLifetimeIncomeCeiling } = require('../services/income/incomeCapPolicy');
  const { getPackagePolicy } = require('../services/packagePolicy');

  const [members] = await pool.query(
    `SELECT u.uid, u.currentaccttype
       FROM usertab u WHERE u.uid = u.mainid
      ORDER BY u.uid ASC ${limit ? `LIMIT ${limit}` : ''}`
  );
  console.log(`[settle-unilevel] ${members.length} member(s)${dryRun ? '  (DRY RUN — no writes)' : ''}`);
  if (!isUnilevelReleaseWindow()) {
    console.log('[settle-unilevel] NOTE: it is before the 5th (Manila) — release window is CLOSED.');
    console.log('[settle-unilevel] getUnilevel() returns 0 until the 5th, so this run credits nothing by design.');
  }

  let credited = 0, creditedAmount = 0, voided = 0, capped = 0, alreadyDone = 0, lockFail = 0, eligible = 0;

  for (const m of members) {
    const uid = Number(m.uid);
    const accttype = Number(m.currentaccttype || 0);

    if (dryRun) {
      // Read-only preview: would this member credit? (>=200 maintenance AND not yet settled)
      // eslint-disable-next-line no-await-in-loop
      const has = await checkLastMaintenance(uid);
      // eslint-disable-next-line no-await-in-loop
      const done = await checkUnilevelTransDate(uid);
      if (done) alreadyDone += 1; else if (has) eligible += 1; else voided += 1;
      continue;
    }

    const lockKey = `nogatu_income_calc_${uid}`;
    // eslint-disable-next-line no-await-in-loop
    const conn = await pool.getConnection();
    try {
      // eslint-disable-next-line no-await-in-loop
      const [lk] = await conn.query('SELECT GET_LOCK(?, 10) AS s', [lockKey]);
      if (Number(lk[0]?.s || 0) !== 1) { lockFail += 1; continue; }

      // H2 backstop: skip if a unilevel (income4) credit already exists this month, independent
      // of the incometransdatetab stamp — so a deleted/reset stamp can never re-credit (double-pay).
      // eslint-disable-next-line no-await-in-loop
      if (await hasUnilevelCreditedThisMonth(uid, conn)) { voided += 1; continue; }

      // eslint-disable-next-line no-await-in-loop
      const amount = await getUnilevel(uid); // maintenance gate + month stamp guard (returns 0 if already stamped)
      if (amount < 1) { voided += 1; continue; }

      // eslint-disable-next-line no-await-in-loop
      const [[stored]] = await conn.query('SELECT * FROM payouttotaltab WHERE uid = ?', [uid]);
      const cap = applyLifetimeIncomeCeiling({
        packagePolicy: getPackagePolicy(accttype),
        storedTotals: stored || {},
        proposedIncome: { dref: 0, paircash: 0, leadership: 0, unilevel: amount, hifive: 0 },
      });
      const allowedUni = Number(cap.allowedIncome?.unilevel || 0);
      const total = Number(cap.allowedTotal || 0);
      if (total >= 1) {
        // C1: re-read the balance FOR UPDATE inside a txn so a concurrent encashment isn't lost.
        // H1: stamp the month guard in the SAME txn, only after the credit succeeds.
        // eslint-disable-next-line no-await-in-loop
        await conn.beginTransaction();
        try {
          // eslint-disable-next-line no-await-in-loop
          const [fresh] = await conn.query('SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? FOR UPDATE', [uid]);
          const bal = Number(fresh[0]?.ttlcashbalance ?? stored?.ttlcashbalance ?? 0);
          // eslint-disable-next-line no-await-in-loop
          await insertIncome(uid, {
            dref: 0, paircash: 0, leadership: 0, unilevel: allowedUni, hifive: 0, ppctemp: 0,
            beginningbalance: bal, endingbalance: bal + total,
          }, conn);
          // eslint-disable-next-line no-await-in-loop
          await updateIncomeTransDate(uid, 4, conn);
          // eslint-disable-next-line no-await-in-loop
          await conn.commit();
        } catch (txErr) {
          // eslint-disable-next-line no-await-in-loop
          await conn.rollback();
          throw txErr;
        }
        credited += 1; creditedAmount += allowedUni;
      } else {
        capped += 1; // at lifetime ceiling — nothing creditable
      }
    } finally {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch { /* noop */ }
      conn.release();
    }

    if ((credited + voided + capped) % 500 === 0) {
      console.log(`  ...processed ${credited + voided + capped} (credited=${credited})`);
    }
  }

  if (dryRun) {
    console.log(`[settle-unilevel] DRY RUN: would-credit=${eligible}  void(<200)=${voided}  already-settled=${alreadyDone}`);
  } else {
    console.log(`[settle-unilevel] credited=${credited} amount=${creditedAmount.toFixed(2)} void(<200 or already)=${voided} capped(ceiling)=${capped} lockFail=${lockFail}`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
