/**
 * LOCAL READ-ONLY account trace across multiple mysqldump snapshots.
 * Shows a member's package state (accttype / currentaccttype / codeid / binarypoints) and
 * their upgradetab history in EACH dump file, so package changes over time are visible
 * (e.g. "was Diamond, became Garnet").
 *
 * Usage:
 *   node scripts/dump_trace_account.js <uid|username> "<dump1.sql>" ["<dump2.sql>" ...]
 *   (if no dump files given, scans reference_system/*.sql sorted by name)
 * READ-ONLY: only reads files.
 */
const fs = require('fs');
const path = require('path');

const PKG = { 10: 'Bronze', 20: 'Silver', 30: 'Gold', 40: 'Platinum', 50: 'Garnet', 60: 'Diamond' };

function getColumns(text, table) {
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
function parseTable(text, table) {
  const cols = getColumns(text, table);
  if (!cols) return { cols: [], rows: [], idx: {} };
  const rows = [];
  const insRe = new RegExp('INSERT INTO `' + table + '`(?:\\s*\\([^)]*\\))?\\s*VALUES', 'g');
  let m;
  while ((m = insRe.exec(text))) {
    let i = m.index + m[0].length, depth = 0, inStr = false, field = '', row = null;
    while (i < text.length) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { field += ch + (text[i + 1] || ''); i += 2; continue; }
        if (ch === "'") { inStr = false; field += ch; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === "'") { inStr = true; field += ch; i++; continue; }
      if (ch === '(') { if (depth === 0) { row = []; field = ''; } else field += ch; depth++; i++; continue; }
      if (ch === ')') { depth--; if (depth === 0) { row.push(field); rows.push(row.map(unescape)); field = ''; } else field += ch; i++; continue; }
      if (ch === ',') { if (depth === 1) { row.push(field); field = ''; } else if (depth > 1) field += ch; i++; continue; }
      if (ch === ';' && depth === 0) { i++; break; }
      if (depth === 0 && /\s/.test(ch)) { i++; continue; }
      field += ch; i++;
    }
  }
  const idx = Object.fromEntries(cols.map((c, k) => [c, k]));
  return { cols, rows, idx };
}

const target = process.argv[2];
if (!target) { console.error('Usage: node scripts/dump_trace_account.js <uid|username> [dump.sql ...]'); process.exit(1); }
let files = process.argv.slice(3);
if (!files.length) {
  const dir = path.resolve(__dirname, '../../reference_system');
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort()
      .map((f) => path.join(dir, f));
  } catch (e) { console.error('no dump dir', dir); process.exit(1); }
}

console.log(`\n[dump_trace_account] target=${target}  files=${files.length}\n`);
const G = (idx, row, name) => row[idx[name]];

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const u = parseTable(text, 'usertab');
  const mem = parseTable(text, 'memberstab');
  const upg = parseTable(text, 'upgradetab');

  // resolve uid
  let uid = null;
  if (/^\d+$/.test(target)) uid = target;
  else {
    const mrow = mem.rows.find((r) => String(G(mem.idx, r, 'username')) === target);
    if (mrow) uid = String(G(mem.idx, mrow, 'uid'));
  }
  const urow = uid ? u.rows.find((r) => String(G(u.idx, r, 'uid')) === String(uid)) : null;

  const base = path.basename(file);
  if (!urow) { console.log(`${base.padEnd(34)} — not found`); continue; }

  const acct = Number(G(u.idx, urow, 'accttype'));
  const cur = Number(G(u.idx, urow, 'currentaccttype'));
  const codeid = Number(G(u.idx, urow, 'codeid'));
  const bp = Number(G(u.idx, urow, 'binarypoints'));
  const dr = Number(G(u.idx, urow, 'directreferral'));
  const code = G(u.idx, urow, 'activationcode');
  const reg = G(u.idx, urow, 'datereg');
  const myUp = upg.rows.filter((r) => String(G(upg.idx, r, 'uid')) === String(uid))
    .map((r) => `to:${PKG[Number(G(upg.idx, r, 'producttype'))] || G(upg.idx, r, 'producttype')}(tt${G(upg.idx, r, 'transtype')},bp${G(upg.idx, r, 'binarypoints')},${String(G(upg.idx, r, 'transdate')).slice(0, 10)})`)
    .join(' ');

  console.log(`${base.padEnd(34)} uid=${uid} orig=${PKG[acct] || acct}(${acct}) current=${PKG[cur] || cur}(${cur}) ` +
    `codeid=${codeid} bp=${bp} dr=${dr} code=${code || '-'} reg=${String(reg).slice(0, 10)}`);
  if (myUp) console.log(`${' '.repeat(34)} upgrades: ${myUp}`);
}

console.log(`\nlegend: orig=accttype(registration)  current=currentaccttype(live in that snapshot)`);
console.log(`Diamond=60 Garnet=50 Platinum=40 Gold=30 Silver=20 Bronze=10`);
console.log(`bp(binarypoints): Diamond=15000 Garnet=5000 Platinum=2500 Gold=1000 Silver=500 Bronze=250\n`);
