/**
 * READ-ONLY diagnostic: trace why a member's binary legs produce 0 matched PV.
 * Usage: node scripts/diag_pairing.js [username]   (default 00001)
 *
 * No writes. Walks both binary legs (refid) and classifies every node by
 * pairing-source eligibility: PD (codeid=1) or fully-paid CD (codeid=3,cdstatus=2).
 */
const mysql = require('mysql2/promise');
const { loadBackendEnv, getDbConfig } = require('./env');

function isCdFullyPaid(r) {
  const cdStatus = Number(r.cdstatus || 0);
  if (cdStatus !== 2) return false;
  const cdAmount = Number(r.cdamount || 0);
  const cdTotal = Number(r.cdtotal || 0);
  if (cdAmount <= 0) return true;
  return cdTotal >= cdAmount;
}
function isPairingSource(r) {
  if (Number(r.codeid) === 1) return true;
  if (Number(r.codeid) === 3 && isCdFullyPaid(r)) return true;
  return false;
}
const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };

async function main() {
  const envFile = loadBackendEnv();
  const cfg = getDbConfig();
  const username = process.argv[2] || '00001';
  const conn = await mysql.createConnection(cfg);
  console.log(`\n[diag] env=${envFile} db=${cfg.database}@${cfg.host} target=@${username}\n`);

  const [meRows] = await conn.query(
    `SELECT u.uid, u.refid, u.position, u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
            u.currentaccttype, u.binarypoints, m.username, m.firstname, m.lastname
       FROM usertab u JOIN memberstab m ON m.uid = u.uid
      WHERE m.username = ? LIMIT 1`,
    [username]
  );
  if (meRows.length === 0) { console.log('Account not found.'); await conn.end(); return; }
  const me = meRows[0];
  console.log(`ROOT uid=${me.uid} ${me.firstname} ${me.lastname} @${me.username} `
    + `code=${CODE_LABEL[me.codeid] || me.codeid} acct=${me.currentaccttype} bp=${me.binarypoints}\n`);

  // Direct binary children.
  const [kids] = await conn.query(
    `SELECT uid, position FROM usertab WHERE refid = ? ORDER BY position ASC`, [me.uid]);
  const legRoot = (pos) => (kids.find((k) => Number(k.position) === pos)?.uid) || null;

  for (const [legName, pos] of [['LEFT', 1], ['RIGHT', 2]]) {
    const root = legRoot(pos);
    if (!root) { console.log(`${legName} leg: (empty)\n`); continue; }

    // BFS the whole subtree under this leg root.
    const all = [];
    let frontier = [root];
    while (frontier.length) {
      const [rows] = await conn.query(
        `SELECT u.uid, u.refid, u.position, u.codeid, u.cdstatus, u.cdamount, u.cdtotal,
                u.currentaccttype, u.binarypoints, m.username
           FROM usertab u JOIN memberstab m ON m.uid = u.uid
          WHERE u.refid IN (${frontier.map(() => '?').join(',')})`,
        frontier
      );
      // include the leg root itself on first pass
      if (all.length === 0) {
        const [rootRow] = await conn.query(
          `SELECT u.uid,u.codeid,u.cdstatus,u.cdamount,u.cdtotal,u.currentaccttype,u.binarypoints,m.username
             FROM usertab u JOIN memberstab m ON m.uid=u.uid WHERE u.uid=? LIMIT 1`, [root]);
        if (rootRow[0]) all.push(rootRow[0]);
      }
      all.push(...rows);
      frontier = rows.map((r) => r.uid);
    }

    const total = all.length;
    const eligible = all.filter(isPairingSource);
    const byCode = { PD: 0, FS: 0, CD_unpaid: 0, CD_paid: 0 };
    let eligiblePoints = 0;
    for (const r of all) {
      if (Number(r.codeid) === 1) byCode.PD += 1;
      else if (Number(r.codeid) === 2) byCode.FS += 1;
      else if (Number(r.codeid) === 3) (isCdFullyPaid(r) ? byCode.CD_paid++ : byCode.CD_unpaid++);
      if (isPairingSource(r)) eligiblePoints += Number(r.binarypoints || 0);
    }

    console.log(`${legName} leg: ${total} accounts | eligible sources=${eligible.length} `
      + `| eligible binarypoints=${eligiblePoints} (=${eligiblePoints / 250} PV @250)`);
    console.log(`   breakdown: PD=${byCode.PD} FS=${byCode.FS} CD_unpaid=${byCode.CD_unpaid} CD_paid=${byCode.CD_paid}`);
    if (total <= 25) {
      for (const r of all) {
        console.log(`   - uid=${r.uid} @${r.username} code=${CODE_LABEL[r.codeid] || r.codeid}`
          + ` cdstatus=${r.cdstatus} acct=${r.currentaccttype} bp=${r.binarypoints}`
          + ` ${isPairingSource(r) ? 'ELIGIBLE' : 'not-source'}`);
      }
    } else if (eligible.length <= 25) {
      console.log(`   eligible sources:`);
      for (const r of eligible) {
        console.log(`   - uid=${r.uid} @${r.username} code=${CODE_LABEL[r.codeid] || r.codeid}`
          + ` acct=${r.currentaccttype} bp=${r.binarypoints}`);
      }
    }
    console.log('');
  }

  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
