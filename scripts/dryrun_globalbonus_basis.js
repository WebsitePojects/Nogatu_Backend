/**
 * READ-ONLY DRY-RUN — Global Bonus basis change (Minutes concern #6/D).
 *
 * Proves the money impact of switching the 2% annual pool basis FROM entry packages
 * (producttype 10-90) TO used repurchase PRODUCTS only (producttype 100-109), scoped
 * to the year by dateused, before any prod deploy.
 *
 * For every year present in codestab.dateused it prints:
 *   OLD basis (packages 10-90)  -> oldSales, oldPool(2%)
 *   NEW basis (products 100-109) -> newSales, newPool(2%)
 *   delta pool
 * plus a per-producttype breakdown, the ALREADY-DISTRIBUTED pools (retroactive-risk
 * check — those stored rows do NOT change, only future re-distribution would), and a
 * voucher-overlap probe (vouchers must be excluded; they live in voucher_*tab).
 *
 * Usage:
 *   GREEN  (staging): node scripts/dryrun_globalbonus_basis.js
 *   BLUE   (prod):    NODE_ENV=production node scripts/dryrun_globalbonus_basis.js
 * READ-ONLY. No writes. Safe on blue.
 */
const { loadBackendEnv, getDbConfig } = require('./env');

const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  console.log(`\n[dryrun_globalbonus_basis] READ-ONLY · env=${envFile} DB=${cfg.user}@${cfg.host}/${cfg.database}`);
  console.log('OLD basis = packages (producttype 10-90) · NEW basis = repurchase products (100-109) · pool = 2% of basis\n');

  const { pool } = require('../config/database');

  // Years that have any used code (codestatus=2) with a real dateused.
  const [yearRows] = await pool.query(
    `SELECT DISTINCT YEAR(dateused) AS y
       FROM codestab
      WHERE codestatus = 2 AND dateused IS NOT NULL AND YEAR(dateused) > 0
      ORDER BY y`
  );
  const years = yearRows.map((r) => Number(r.y)).filter(Boolean);
  if (!years.length) {
    console.log('No used codes with a dateused found. Nothing to compare.');
  }

  console.log('YEAR | OLD packages sales | OLD pool 2% | NEW products sales | NEW pool 2% | Δ pool');
  console.log('-----+--------------------+-------------+--------------------+-------------+--------');
  for (const y of years) {
    const [[oldR]] = await pool.query(
      `SELECT COALESCE(SUM(productamount),0) AS s, COUNT(*) AS c
         FROM codestab
        WHERE codestatus = 2 AND producttype >= 10 AND producttype <= 90 AND YEAR(dateused) = ?`,
      [y]
    );
    const [[newR]] = await pool.query(
      `SELECT COALESCE(SUM(productamount),0) AS s, COUNT(*) AS c
         FROM codestab
        WHERE codestatus = 2 AND producttype >= 100 AND producttype < 200 AND YEAR(dateused) = ?`,
      [y]
    );
    const oldSales = Number(oldR.s || 0), newSales = Number(newR.s || 0);
    const oldPool = oldSales * 0.02, newPool = newSales * 0.02;
    console.log(
      `${y} | ${peso(oldSales).padStart(18)} | ${peso(oldPool).padStart(11)} | ` +
      `${peso(newSales).padStart(18)} | ${peso(newPool).padStart(11)} | ${peso(newPool - oldPool)}` +
      `   (old rows=${oldR.c}, new rows=${newR.c})`
    );
  }

  // Per-producttype breakdown across all used codes (confirms 10-60 = packages, 100-109 = products).
  console.log('\n--- per-producttype breakdown (codestatus=2, all years) ---');
  const [byType] = await pool.query(
    `SELECT producttype, COUNT(*) AS c, COALESCE(SUM(productamount),0) AS s
       FROM codestab
      WHERE codestatus = 2
      GROUP BY producttype
      ORDER BY producttype`
  );
  for (const r of byType) {
    const bucket = (r.producttype >= 100 && r.producttype < 200) ? 'PRODUCT (NEW basis)'
      : (r.producttype >= 10 && r.producttype <= 90) ? 'package (OLD basis)' : 'other';
    console.log(`  producttype ${String(r.producttype).padStart(4)} | rows=${String(r.c).padStart(7)} | sum=${peso(r.s).padStart(18)} | ${bucket}`);
  }

  // Under-count probe (reviewer 🟡): used PRODUCT codes with NULL dateused are genuinely
  // used but YEAR(dateused)=? silently drops them from the pool. Surface the magnitude so
  // it is a conscious business call, not a silent loss.
  console.log('\n--- used products with NULL dateused (silently excluded from every year) ---');
  try {
    const [[nd]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(productamount),0) AS s
         FROM codestab
        WHERE codestatus = 2 AND producttype >= 100 AND producttype <= 109 AND dateused IS NULL`
    );
    console.log(`  rows=${nd.c} sum=${peso(nd.s)}` +
      (Number(nd.c) > 0
        ? `  ← ${peso(Number(nd.s) * 0.02)} of pool is invisible to the year-scoped basis. Decide: backfill dateused or accept.`
        : '  ← clean (all used products have a dateused).'));
  } catch (e) {
    console.log(`  NULL-dateused probe skipped: ${e.code || e.message}`);
  }

  // Already-distributed pools: stored rows do NOT change; only FUTURE distribution differs.
  console.log('\n--- already-distributed global-bonus pools (retroactive-risk check) ---');
  try {
    const [pools] = await pool.query(
      `SELECT period_year, period_month, total_net_sales, bonus_pool, total_portions, status,
              DATE_FORMAT(distributed_date,'%Y-%m-%d %H:%i') AS distributed_date
         FROM globalbonus_poolstab
        WHERE period_scope = 'annual'
        ORDER BY period_year DESC`
    );
    if (!pools.length) {
      console.log('  none distributed yet → basis change has ZERO retroactive money impact (affects future/preview only).');
    } else {
      for (const p of pools) {
        console.log(`  year=${p.period_year} status=${p.status === 1 ? 'DISTRIBUTED' : p.status} ` +
          `stored_net_sales=${peso(p.total_net_sales)} stored_pool=${peso(p.bonus_pool)} ` +
          `portions=${p.total_portions} on=${p.distributed_date || '-'}`);
      }
      console.log('  NOTE: stored distributed rows are immutable history; re-running distribute for these years' +
        ' would now use the NEW basis. Do NOT re-distribute a closed/paid year without explicit sign-off.');
    }
  } catch (e) {
    console.log(`  globalbonus_poolstab not present / readable: ${e.code || e.message}`);
  }

  // Voucher exclusion probe: vouchers live in voucher_transactionstab; confirm they are NOT
  // double-counted as codestab producttype>=100 rows. Report any code linkage if it exists.
  console.log('\n--- voucher exclusion probe ---');
  try {
    const [[vt]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total_value),0) AS v FROM voucher_transactionstab`
    );
    console.log(`  voucher_transactionstab: rows=${vt.c} total_value=${peso(vt.v)} — tracked SEPARATELY (not in codestab basis).`);
  } catch (e) {
    console.log(`  voucher_transactionstab not present: ${e.code || e.message} (nothing to exclude).`);
  }
  // If voucher availment ever flips a codestab product code to codestatus=2, it would leak into
  // the NEW basis. Surface any product code used with NO owning member (uid NULL) as a candidate.
  try {
    const [[leak]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(productamount),0) AS s
         FROM codestab
        WHERE codestatus = 2 AND producttype >= 100 AND producttype < 200 AND (uid IS NULL OR uid = 0)`
    );
    console.log(`  used product codes with NO owner uid (voucher/admin-path candidates): rows=${leak.c} sum=${peso(leak.s)}` +
      (Number(leak.c) > 0 ? '  ← REVIEW: confirm these are genuine repurchases, not voucher availments.' : '  ← clean.'));
  } catch (e) {
    console.log(`  owner-uid probe skipped: ${e.code || e.message}`);
  }

  console.log('\nDone (read-only).');
  await pool.end().catch(() => {});
}

main().catch((err) => { console.error('[dryrun_globalbonus_basis] ERROR:', err); process.exit(1); });
