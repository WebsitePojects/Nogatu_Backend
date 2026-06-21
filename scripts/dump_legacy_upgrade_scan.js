/**
 * LOCAL READ-ONLY dump analyzer (no DB). Parses a mysqldump .sql file and characterizes the
 * legacy upgrade-pairing gap: accounts that upgraded but whose upgrade binary PV cannot flow
 * upstream in the Node engine.
 *
 * Engine recap (services/income/pairing.js):
 *   - A node contributes its frozen usertab.binarypoints when countsForPairingSource.
 *   - The UPGRADE delta only flows when BOTH: accttype < currentaccttype  AND a
 *     `upgradetab transtype=1` row exists (appendUpgradePairingBonus reads that row).
 *
 * Legacy PHP upgrades often set usertab.accttype = the new package directly (so
 * accttype == currentaccttype). Those are invisible to the `<` test, so the engine treats
 * them as fresh accounts at the new package — and their upgrade event never replays upstream.
 *
 * Usage:  node scripts/dump_legacy_upgrade_scan.js "<path-to-dump.sql>"
 * READ-ONLY: only reads the file.
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/dump_legacy_upgrade_scan.js <dump.sql>'); process.exit(1); }
const text = fs.readFileSync(file, 'utf8');

function getColumns(table) {
  const m = text.match(new RegExp('CREATE TABLE `' + table + '` \\(([\\s\\S]*?)\\n\\) ENGINE'));
  if (!m) return null;
  const cols = [];
  for (const line of m[1].split('\n')) {
    const cm = line.match(/^\s+`([a-zA-Z0-9_]+)`\s/);
    if (cm) cols.push(cm[1]);
  }
  return cols;
}

function unescape(tok) {
  tok = String(tok).trim();
  if (tok === 'NULL') return null;
  if (tok.length >= 2 && tok[0] === "'" && tok[tok.length - 1] === "'") {
    return tok.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return tok;
}

function parseTable(table) {
  const cols = getColumns(table);
  if (!cols) { console.error(`table ${table} not found`); return { cols: [], rows: [] }; }
  const rows = [];
  // Matches both `INSERT INTO `t` VALUES` and phpMyAdmin `INSERT INTO `t` (`c`,..) VALUES`,
  // with the values starting on the same or next line.
  const insRe = new RegExp('INSERT INTO `' + table + '`(?:\\s*\\([^)]*\\))?\\s*VALUES', 'g');
  let m;
  while ((m = insRe.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 0, inStr = false, field = '', row = null;
    while (i < text.length) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { field += ch + (text[i + 1] || ''); i += 2; continue; }
        if (ch === "'") { inStr = false; field += ch; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === "'") { inStr = true; field += ch; i++; continue; }
      if (ch === '(') { if (depth === 0) { row = []; field = ''; } else field += ch; depth++; i++; continue; }
      if (ch === ')') {
        depth--;
        if (depth === 0) { row.push(field); rows.push(row.map(unescape)); field = ''; }
        else field += ch;
        i++; continue;
      }
      if (ch === ',') { if (depth === 1) { row.push(field); field = ''; } else if (depth > 1) field += ch; i++; continue; }
      if (ch === ';' && depth === 0) { i++; break; }
      if (depth === 0 && /\s/.test(ch)) { i++; continue; }
      field += ch; i++;
    }
  }
  const idx = Object.fromEntries(cols.map((c, k) => [c, k]));
  return {
    cols,
    rows,
    get(row, name) { return row[idx[name]]; },
    objects() { return rows.map((r) => Object.fromEntries(cols.map((c, k) => [c, r[k]]))); },
  };
}

const N = (v) => Number(v || 0);

console.log(`\n[dump_legacy_upgrade_scan] file=${file}\n`);

const user = parseTable('usertab');
const upg = parseTable('upgradetab');
const members = parseTable('memberstab');
console.log(`rows: usertab=${user.rows.length} upgradetab=${upg.rows.length} memberstab=${members.rows.length}\n`);

const users = user.objects();
const upgrades = upg.objects();
const memberName = new Map(members.objects().map((m) => [String(m.uid), m.username]));

// upgradetab transtype distribution
const ttDist = {};
const uidsByTranstype = {};
for (const u of upgrades) {
  const tt = String(u.transtype);
  ttDist[tt] = (ttDist[tt] || 0) + 1;
  (uidsByTranstype[tt] = uidsByTranstype[tt] || new Set()).add(String(u.uid));
}
console.log('upgradetab transtype distribution (rows):', ttDist);
console.log('upgradetab distinct uids by transtype:',
  Object.fromEntries(Object.entries(uidsByTranstype).map(([k, v]) => [k, v.size])));

const upgUids = new Set(upgrades.map((u) => String(u.uid)));
const upgUidsT1 = uidsByTranstype['1'] || new Set();

// Classify usertab accounts
let modernUpgrade = 0;          // accttype < currentaccttype (engine detects)
let modernNoEvent = 0;          // accttype < currentaccttype but NO transtype=1 row
let legacyOverwritten = 0;      // accttype == currentaccttype BUT has upgradetab row(s)
let legacyOverwrittenT1 = 0;    // ...with a transtype=1 row specifically
const legacySamples = [];
const modernNoEventSamples = [];

for (const u of users) {
  const uid = String(u.uid);
  const a = N(u.accttype), c = N(u.currentaccttype);
  const hasUpg = upgUids.has(uid);
  const hasT1 = upgUidsT1.has(uid);
  if (a < c) {
    modernUpgrade++;
    if (!hasT1) { modernNoEvent++; if (modernNoEventSamples.length < 15) modernNoEventSamples.push(u); }
  } else if (a === c && hasUpg) {
    legacyOverwritten++;
    if (hasT1) legacyOverwrittenT1++;
    if (legacySamples.length < 25) legacySamples.push(u);
  }
}

console.log(`\n=== UPGRADE CLASSIFICATION (usertab vs upgradetab) ===`);
console.log(`accounts with ANY upgradetab row:                 ${upgUids.size}`);
console.log(`accounts with a transtype=1 upgradetab row:       ${upgUidsT1.size}`);
console.log(`MODERN upgrade (accttype < currentaccttype):      ${modernUpgrade}`);
console.log(`   ...of those MISSING transtype=1 event:         ${modernNoEvent}`);
console.log(`LEGACY-OVERWRITTEN (accttype==currentaccttype      ${legacyOverwritten}`);
console.log(`   AND has upgradetab row) -> engine misses it`);
console.log(`   ...of those with a transtype=1 row:            ${legacyOverwrittenT1}`);

console.log(`\n--- sample LEGACY-OVERWRITTEN accounts (accttype==currentaccttype but upgraded) ---`);
console.log('  uid        username            acct/cur  codeid  binarypts  upg_rows(transtypes,bp)');
for (const u of legacySamples) {
  const uid = String(u.uid);
  const myUp = upgrades.filter((x) => String(x.uid) === uid)
    .map((x) => `tt${x.transtype}:bp${x.binarypoints}:p${x.producttype}`).join(' ');
  console.log(`  ${uid.padEnd(10)} ${String(memberName.get(uid) || '?').slice(0, 18).padEnd(18)} ` +
    `${String(N(u.accttype)).padStart(3)}/${String(N(u.currentaccttype)).padEnd(3)}    ${String(N(u.codeid)).padEnd(6)}  ` +
    `${String(N(u.binarypoints)).padEnd(9)}  ${myUp}`);
}

if (modernNoEventSamples.length) {
  console.log(`\n--- sample MODERN-but-NO-EVENT accounts (accttype<currentaccttype, no transtype=1) ---`);
  for (const u of modernNoEventSamples) {
    const uid = String(u.uid);
    const myUp = upgrades.filter((x) => String(x.uid) === uid)
      .map((x) => `tt${x.transtype}:bp${x.binarypoints}`).join(' ') || '(none)';
    console.log(`  ${uid.padEnd(10)} ${String(memberName.get(uid) || '?').slice(0, 18).padEnd(18)} ` +
      `${N(u.accttype)}/${N(u.currentaccttype)} codeid=${N(u.codeid)} bp=${N(u.binarypoints)} upg=${myUp}`);
  }
}

console.log(`\nNOTE: read-only file analysis. "LEGACY-OVERWRITTEN" is the hidden population — the`);
console.log(`engine cannot replay their upgrade PV upstream because accttype==currentaccttype.\n`);
