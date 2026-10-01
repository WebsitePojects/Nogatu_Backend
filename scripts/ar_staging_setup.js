/**
 * AR staging setup — STAGING ONLY. Refuses to run against any database but nogatualliance_staging.
 *
 * Prepares green for management review of the AR system (decided 2026-10-01):
 *   1. AR sequence: seeded with a RANDOM starting number (the real latest paper AR number is not
 *      known yet; production must be seeded by Super Admin with Dino's number instead).
 *   2. Price list: INVENTED stockist prices and SRPs so every mode can be demonstrated. Existing
 *      rows are never overwritten, so prices a Super Admin already edited survive a re-run.
 *        packages 10-60  member = stockist = SRP = package amount (stockists get Dino's peso discount)
 *        products 100-109 member = catalog price, stockist = member x 0.85, SRP = member / 0.70,
 *                         both rounded to the nearest 5 pesos
 *   3. Cashier logins: ryanbere -> Caloocan, jedlopez -> Tycoon (identity to be confirmed by
 *      management), and a NEW mgbalcos (Mary Grace Balcos) -> Caloocan with a one-time password.
 *
 * Dry run by default; pass --commit to write.
 *   cd /var/www/nogatu-green && node scripts/ar_staging_setup.js            # dry run
 *   cd /var/www/nogatu-green && node scripts/ar_staging_setup.js --commit
 * (No NODE_ENV prefix on green: it loads .env.dev -> nogatualliance_staging.)
 */
const crypto = require('crypto');
const { loadBackendEnv, getDbConfig } = require('./env');

const envFile = loadBackendEnv();
const cfg = getDbConfig();
const COMMIT = process.argv.includes('--commit');
const STAGING_DB = 'nogatualliance_staging';

const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
const { PRODUCT_CONFIG } = require('../services/codeGeneration');
const { MAINTENANCE_PRODUCT_CATALOG } = require('../constants/maintenanceProductCatalog');

const round5 = (n) => Math.round(n / 5) * 5;

function inventedPrices() {
  const rows = [];
  for (const pt of [10, 20, 30, 40, 50, 60]) {
    const amount = Number(PRODUCT_CONFIG[pt].productamount);
    rows.push({ producttype: pt, item_name: PRODUCT_CONFIG[pt].name, member_price: amount, stockist_price: amount, srp: amount });
  }
  for (const product of MAINTENANCE_PRODUCT_CATALOG) {
    const member = Number(product.price);
    rows.push({
      producttype: product.code, item_name: product.name, member_price: member,
      stockist_price: round5(member * 0.85), srp: round5(member / 0.7),
    });
  }
  return rows;
}

const CASHIERS = [
  { username: 'ryanbere', name: 'Ryan Bere', center: 'CAL', create: false },
  { username: 'jedlopez', name: 'Jed Lopez', center: 'TYC', create: false, note: 'assumed to be Jeraldine Lopez - CONFIRM' },
  { username: 'mgbalcos', name: 'Mary Grace Balcos', center: 'CAL', create: true },
];

async function main() {
  const [[who]] = await pool.query('SELECT CURRENT_USER() u, DATABASE() d');
  console.log(`env=${envFile} DB=${who.u}/${who.d}  mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  if (who.d !== STAGING_DB || cfg.database !== STAGING_DB) {
    console.error(`REFUSED: this script only runs on ${STAGING_DB}. Invented prices must never reach production.`);
    process.exit(1);
  }

  const conn = await pool.getConnection();
  const oneTimePasswords = [];
  try {
    await conn.beginTransaction();

    // 1. Sequence
    const [[seq]] = await conn.query('SELECT next_seq FROM ar_sequencetab WHERE id = 1 FOR UPDATE');
    if (seq?.next_seq == null) {
      const seed = crypto.randomInt(1000, 10000);
      console.log(`sequence   : unseeded -> random seed ${seed} (first AR will be <year>${String(seed + 1).padStart(6, '0')})`);
      await conn.query(
        "UPDATE ar_sequencetab SET next_seq = ?, seeded_from = ?, seeded_by = 'staging-setup', seeded_at = NOW() WHERE id = 1",
        [seed + 1, seed]
      );
    } else {
      console.log(`sequence   : already seeded (next ${seq.next_seq}) - unchanged`);
    }

    // 2. Prices (INSERT IGNORE: never overwrite an edited row)
    let added = 0;
    for (const p of inventedPrices()) {
      const [res] = await conn.query(
        `INSERT IGNORE INTO ar_price_listtab (producttype, item_name, member_price, stockist_price, srp, active, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, 'staging-setup')`,
        [p.producttype, p.item_name, p.member_price, p.stockist_price, p.srp]
      );
      if (res.affectedRows) added += 1;
      console.log(`price      : ${String(p.producttype).padEnd(4)} ${p.item_name.padEnd(36)} member ${p.member_price}  stockist ${p.stockist_price}  SRP ${p.srp}${res.affectedRows ? '' : '  (exists, kept)'}`);
    }
    console.log(`price      : ${added} row(s) added`);

    // 3. Cashiers
    const [centers] = await conn.query('SELECT id, code FROM ar_centertab');
    const centerId = Object.fromEntries(centers.map((c) => [c.code, c.id]));
    for (const c of CASHIERS) {
      const [[existing]] = await conn.query('SELECT id, rights, ar_center_id FROM accesstab WHERE username = ? LIMIT 1', [c.username]);
      if (!existing && !c.create) {
        console.log(`cashier    : ${c.username} NOT FOUND - skipped`);
        continue;
      }
      let id = existing?.id;
      if (!existing) {
        const [[max]] = await conn.query('SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM accesstab FOR UPDATE');
        id = Number(max.nextId);
        const temp = crypto.randomBytes(9).toString('base64url');
        await conn.query(
          "INSERT INTO accesstab (id, uid, username, password, name, rights, role) VALUES (?, ?, ?, ?, ?, 2, 'cashier')",
          [id, id, c.username, await bcrypt.hash(temp, 12), c.name]
        );
        oneTimePasswords.push({ username: c.username, temp });
        console.log(`cashier    : ${c.username} CREATED (id ${id}, rights 2)`);
      } else if (Number(existing.rights) !== 2) {
        console.log(`cashier    : ${c.username} has rights ${existing.rights}, not a cashier - skipped`);
        continue;
      }
      await conn.query('UPDATE accesstab SET ar_center_id = ? WHERE id = ?', [centerId[c.center], id]);
      console.log(`cashier    : ${c.username} -> ${c.center}${c.note ? `  (${c.note})` : ''}`);
    }

    if (COMMIT) {
      await conn.commit();
      console.log('\nCOMMITTED.');
      for (const p of oneTimePasswords) {
        console.log(`ONE-TIME PASSWORD for ${p.username}: ${p.temp}   <- give it privately; it is not stored anywhere else`);
      }
    } else {
      await conn.rollback();
      console.log('\nDRY-RUN: nothing written. Re-run with --commit.');
    }
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
