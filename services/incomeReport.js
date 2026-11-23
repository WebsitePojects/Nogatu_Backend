/**
 * Income release report (management meeting 2026-11-10).
 *
 * READ-ONLY. Month by month: what income the system RELEASED (credits in
 * payouthistorytab) next to what was ENCODED (registrations, upgrades,
 * repurchases), so management can compute realistic averages per package.
 *
 * Fixed query budget: SELECT_COUNT queries regardless of how many months are
 * requested. All month bucketing happens in SQL via GROUP BY; JS only shapes.
 */
const ExcelJS = require('exceljs');
const { getPackagePolicy } = require('./packagePolicy');
const { ACCOUNT_TYPES } = require('../utils/helpers');
const { MAINTENANCE_PRODUCT_CATALOG } = require('../constants/maintenanceProductCatalog');

const MAX_MONTHS = 24;
const PACKAGE_TYPES = Object.keys(ACCOUNT_TYPES).map(Number).sort((a, b) => a - b);

// payouthistorytab / upgradetab / usertab.datereg clock split: legacy PHP rows (before the Node
// cutover on 2026-06-01) store Manila wall-clock time, Node-era rows store UTC
// (utils/helpers.nowMySQL / getOffsetTimestamp both use toISOString). repurchasetab is
// written with MySQL NOW() (server-local Manila), so it is bucketed raw.
// Shifting Node-era rows +8h puts every row on Manila
// time so a credit near a month boundary lands in the right month.
const NODE_ERA_CUTOVER = '2026-06-01';
const manilaMonthSql = (col) =>
  `DATE_FORMAT(CASE WHEN ${col} >= '${NODE_ERA_CUTOVER}' THEN ${col} + INTERVAL 8 HOUR ELSE ${col} END, '%Y-%m')`;
const manilaTimeSql = (col) =>
  `(CASE WHEN ${col} >= '${NODE_ERA_CUTOVER}' THEN ${col} + INTERVAL 8 HOUR ELSE ${col} END)`;
const PAYOUT_MONTH_SQL = manilaMonthSql('transdate');
const PAYOUT_TIME_SQL = manilaTimeSql('transdate');

const INCOME_TYPES = [
  { key: 'directReferral', column: 'income1', label: 'Direct Referral' },
  { key: 'smb', column: 'income2', label: 'Sales Match Bonus' },
  { key: 'leadership', column: 'income3', label: 'Leadership' },
  { key: 'unilevel', column: 'income4', label: 'Unilevel' },
  { key: 'hiFive', column: 'income5', label: 'Hi-Five' },
  { key: 'ranking', column: 'income6', label: 'Ranking' },
];

const PRODUCT_PRICE = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((p) => [p.code, Number(p.price) || 0])
);

// Lazy: never reference the pool as a default-param identifier (lessons 2026-08-06).
function getPool() {
  return require('../config/database').pool;
}

class InvalidRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRangeError';
    this.code = 'INVALID_RANGE';
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ratio = (num, den) => (den > 0 ? round2(num / den) : null);
// A payout ratio is a fraction shown as a percent; 2 dp would turn 28.67% into 29%.
const fractionRatio = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

function parseMonth(value, label) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value ?? ''));
  if (!m) throw new InvalidRangeError(`"${label}" must be a month in YYYY-MM format.`);
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) throw new InvalidRangeError(`"${label}" must be between 2000 and 2100.`);
  return { year, month: Number(m[2]) };
}

const monthIndex = ({ year, month }) => year * 12 + (month - 1);
const monthKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const firstOfMonth = (idx) => `${monthKey(idx)}-01`;

/** Validate and expand the range. Throws INVALID_RANGE before any DB access. */
function resolveRange({ from, to } = {}) {
  if (!from || !to) throw new InvalidRangeError('Both "from" and "to" (YYYY-MM) are required.');
  const fromIdx = monthIndex(parseMonth(from, 'from'));
  const toIdx = monthIndex(parseMonth(to, 'to'));
  if (fromIdx > toIdx) throw new InvalidRangeError('"from" must not be after "to".');
  if (toIdx - fromIdx + 1 > MAX_MONTHS) {
    throw new InvalidRangeError(`Range is limited to ${MAX_MONTHS} months.`);
  }
  const months = [];
  for (let i = fromIdx; i <= toIdx; i += 1) months.push(monthKey(i));
  return {
    from: monthKey(fromIdx),
    to: monthKey(toIdx),
    months,
    // [startDate, endExclusive) in Manila time.
    startDate: firstOfMonth(fromIdx),
    endExclusive: firstOfMonth(toIdx + 1),
    // Coarse sargable prefilter on the RAW column (adjustment is at most +8h).
    rawLow: `${shiftDay(firstOfMonth(fromIdx), -1)} 00:00:00`,
    rawHigh: `${shiftDay(firstOfMonth(toIdx + 1), 1)} 23:59:59`,
  };
}

function shiftDay(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- empty-shape factories -------------------------------------------------

const emptyPackageSplit = () =>
  Object.fromEntries(PACKAGE_TYPES.map((t) => [t, { PD: 0, FS: 0, CD: 0, total: 0 }]));
const emptyPackageCount = () => Object.fromEntries(PACKAGE_TYPES.map((t) => [t, 0]));
const emptyIncome = () => ({
  byType: Object.fromEntries(INCOME_TYPES.map((t) => [t.key, { amount: 0, credits: 0, earners: 0 }])),
  total: 0,
  earners: 0,
});
const emptySmb = () =>
  Object.fromEntries(
    PACKAGE_TYPES.map((t) => [t, { zero: 0, oneToTwo: 0, threeToFour: 0, fivePlus: 0, members: 0, creditMembersOutsideBase: 0 }])
  );

function emptyMonth(month) {
  return {
    month,
    codes: {
      registrations: { total: 0, byPackage: emptyPackageSplit(), packageValue: 0, otherAccountType: 0 },
      upgrades: { total: 0, byPackage: emptyPackageCount() },
      repurchases: { total: 0, amount: 0, points: 0, unpriced: 0 },
    },
    income: emptyIncome(),
    smbDistribution: { byPackage: emptySmb() },
    averages: { incomePerRegistration: null, incomePerEarner: null, payoutRatio: null },
  };
}

function finalizeAverages(m) {
  const { income, codes } = m;
  m.averages = {
    incomePerRegistration: ratio(income.total, codes.registrations.total),
    incomePerEarner: ratio(income.total, income.earners),
    payoutRatio: fractionRatio(income.total, codes.registrations.packageValue),
  };
}

function finalizeMoney(m) {
  m.codes.registrations.packageValue = round2(m.codes.registrations.packageValue);
  m.codes.repurchases.amount = round2(m.codes.repurchases.amount);
  for (const t of INCOME_TYPES) {
    m.income.byType[t.key].amount = round2(m.income.byType[t.key].amount);
  }
  m.income.total = round2(m.income.total);
}

const CODE_LABEL = { 1: 'PD', 2: 'FS', 3: 'CD' };

// ---- the queries (constant count) ------------------------------------------

const SELECT_COUNT = 6;

function buildQueries(r) {
  const incomeSelect = INCOME_TYPES.map(
    (t) =>
      `COALESCE(SUM(CASE WHEN ${t.column} > 0 THEN ${t.column} ELSE 0 END), 0) AS amt_${t.key},
       SUM(${t.column} > 0) AS cnt_${t.key},
       COUNT(DISTINCT CASE WHEN ${t.column} > 0 THEN uid END) AS earn_${t.key}`
  ).join(',\n       ');
  const anyIncome = INCOME_TYPES.map((t) => `${t.column} > 0`).join(' OR ');
  const payoutWhere = `transdate >= ? AND transdate <= ?
       AND ${PAYOUT_TIME_SQL} >= ? AND ${PAYOUT_TIME_SQL} < ?`;
  const payoutParams = [r.rawLow, r.rawHigh, r.startDate, r.endExclusive];

  const upgradeTime = manilaTimeSql('transdate');
  const regTime = manilaTimeSql('datereg');
  const memberRegTime = manilaTimeSql('u.datereg');
  return {
    income: {
      sql: `SELECT ${PAYOUT_MONTH_SQL} AS month,
       ${incomeSelect},
       COUNT(DISTINCT CASE WHEN ${anyIncome} THEN uid END) AS earners
  FROM payouthistorytab
 WHERE ${payoutWhere}
 GROUP BY month`,
      params: payoutParams,
    },
    registrations: {
      sql: `SELECT ${manilaMonthSql('datereg')} AS month, accttype, codeid, COUNT(*) AS n
  FROM usertab
 WHERE datereg >= ? AND datereg <= ?
   AND ${regTime} >= ? AND ${regTime} < ?
 GROUP BY month, accttype, codeid`,
      params: payoutParams,
    },
    upgrades: {
      sql: `SELECT ${manilaMonthSql('transdate')} AS month, producttype, COUNT(*) AS n
  FROM upgradetab
 WHERE transtype = 1
   AND transdate >= ? AND transdate <= ?
   AND ${upgradeTime} >= ? AND ${upgradeTime} < ?
 GROUP BY month, producttype`,
      params: payoutParams,
    },
    repurchases: {
      sql: `SELECT DATE_FORMAT(transdate, '%Y-%m') AS month, producttype,
       COUNT(*) AS n, COALESCE(SUM(incentivepoints1), 0) AS points
  FROM repurchasetab
 WHERE transdate >= ? AND transdate < ?
 GROUP BY month, producttype`,
      params: [r.startDate, r.endExclusive],
    },
    // Per (month, current package): how many members had 1-2 / 3-4 / 5+ SMB
    // credit rows. Members with zero credits are derived from the base below.
    smbCredits: {
      sql: `SELECT c.month, u.currentaccttype AS pkg,
       SUM(c.n BETWEEN 1 AND 2) AS one_two,
       SUM(c.n BETWEEN 3 AND 4) AS three_four,
       SUM(c.n >= 5) AS five_plus,
       -- Credit holders the member base cannot see (no datereg, or registered after the
       -- month). Reported so the zero-bucket arithmetic is never silently clamped.
       SUM(u.datereg IS NULL
           OR ${memberRegTime} >= STR_TO_DATE(CONCAT(c.month, '-01'), '%Y-%m-%d') + INTERVAL 1 MONTH) AS outside_base
  FROM (SELECT uid, ${PAYOUT_MONTH_SQL} AS month, COUNT(*) AS n
          FROM payouthistorytab
         WHERE income2 > 0 AND ${payoutWhere}
         GROUP BY uid, month) c
  JOIN usertab u ON u.uid = c.uid
 GROUP BY c.month, u.currentaccttype`,
      params: payoutParams,
    },
    // Member base: registered before the range (bucket 'pre') or per month.
    memberBase: {
      // usertab is a few thousand rows; the unsargable Manila expression is fine here.
      sql: `SELECT currentaccttype AS pkg,
       CASE WHEN ${regTime} < ? THEN 'pre' ELSE ${manilaMonthSql('datereg')} END AS bucket,
       COUNT(*) AS n
  FROM usertab
 WHERE ${regTime} < ?
 GROUP BY pkg, bucket`,
      params: [r.startDate, r.endExclusive],
    },
  };
}

// ---- shaping ----------------------------------------------------------------

function shapeReport(range, rows) {
  const byMonth = new Map(range.months.map((m) => [m, emptyMonth(m)]));
  const slot = (m) => byMonth.get(m);

  for (const row of rows.income) {
    const m = slot(row.month);
    if (!m) continue;
    for (const t of INCOME_TYPES) {
      const bucket = m.income.byType[t.key];
      // Round per type first so the total always equals the sum of what is shown.
      bucket.amount = round2(row[`amt_${t.key}`]);
      bucket.credits = Number(row[`cnt_${t.key}`]) || 0;
      bucket.earners = Number(row[`earn_${t.key}`]) || 0;
      m.income.total = round2(m.income.total + bucket.amount);
    }
    m.income.earners = Number(row.earners) || 0;
  }

  for (const row of rows.registrations) {
    const m = slot(row.month);
    const pkg = Number(row.accttype);
    const code = CODE_LABEL[Number(row.codeid)];
    if (!m) continue;
    const n = Number(row.n) || 0;
    if (!m.codes.registrations.byPackage[pkg]) {
      // Legacy rows exist with a non-package accttype (e.g. 100). Count them so the total
      // reconciles with usertab, but give them no package value.
      m.codes.registrations.otherAccountType += n;
      m.codes.registrations.total += n;
      continue;
    }
    const cell = m.codes.registrations.byPackage[pkg];
    if (code) cell[code] += n;
    cell.total += n;
    m.codes.registrations.total += n;
    m.codes.registrations.packageValue += n * getPackagePolicy(pkg).packageAmount;
  }

  for (const row of rows.upgrades) {
    const m = slot(row.month);
    const pkg = Number(row.producttype);
    if (!m || m.codes.upgrades.byPackage[pkg] === undefined) continue;
    const n = Number(row.n) || 0;
    m.codes.upgrades.byPackage[pkg] += n;
    m.codes.upgrades.total += n;
  }

  for (const row of rows.repurchases) {
    const m = slot(row.month);
    if (!m) continue;
    const n = Number(row.n) || 0;
    m.codes.repurchases.total += n;
    m.codes.repurchases.points += Number(row.points) || 0;
    // SRP value from the catalog: Node-era repurchasetab rows carry no amount.
    const price = PRODUCT_PRICE[Number(row.producttype)];
    if (price) m.codes.repurchases.amount += n * price;
    // Never value an unknown product at 0 silently: count it so the gap is visible.
    else m.codes.repurchases.unpriced += n;
  }

  // Members per (month, package) = registered on or before that month's end.
  const baseByPkg = {};
  for (const row of rows.memberBase) {
    const pkg = Number(row.pkg);
    baseByPkg[pkg] = baseByPkg[pkg] || {};
    baseByPkg[pkg][row.bucket] = (baseByPkg[pkg][row.bucket] || 0) + (Number(row.n) || 0);
  }
  for (const pkg of PACKAGE_TYPES) {
    let running = (baseByPkg[pkg] && baseByPkg[pkg].pre) || 0;
    for (const month of range.months) {
      running += (baseByPkg[pkg] && baseByPkg[pkg][month]) || 0;
      slot(month).smbDistribution.byPackage[pkg].members = running;
    }
  }
  for (const row of rows.smbCredits) {
    const m = slot(row.month);
    const cell = m && m.smbDistribution.byPackage[Number(row.pkg)];
    if (!cell) continue;
    cell.oneToTwo = Number(row.one_two) || 0;
    cell.threeToFour = Number(row.three_four) || 0;
    cell.fivePlus = Number(row.five_plus) || 0;
    cell.creditMembersOutsideBase = Number(row.outside_base) || 0;
  }
  for (const m of byMonth.values()) {
    for (const cell of Object.values(m.smbDistribution.byPackage)) {
      const creditMembersInBase =
        cell.oneToTwo + cell.threeToFour + cell.fivePlus - (cell.creditMembersOutsideBase || 0);
      cell.zero = Math.max(0, cell.members - creditMembersInBase);
    }
    finalizeMoney(m);
    finalizeAverages(m);
  }

  const months = range.months.map((k) => byMonth.get(k));
  const totals = sumMonths(months);
  return { range: { from: range.from, to: range.to, months: range.months }, months, totals };
}

/** Totals: counts and money summed; earners/members are member-months. */
function sumMonths(months) {
  const t = emptyMonth('total');
  for (const m of months) {
    const reg = m.codes.registrations;
    t.codes.registrations.total += reg.total;
    t.codes.registrations.packageValue += reg.packageValue;
    t.codes.registrations.otherAccountType += reg.otherAccountType;
    t.codes.upgrades.total += m.codes.upgrades.total;
    t.codes.repurchases.total += m.codes.repurchases.total;
    t.codes.repurchases.amount += m.codes.repurchases.amount;
    t.codes.repurchases.points += m.codes.repurchases.points;
    t.codes.repurchases.unpriced += m.codes.repurchases.unpriced;
    t.income.total += m.income.total;
    t.income.earners += m.income.earners;
    for (const pkg of PACKAGE_TYPES) {
      const a = t.codes.registrations.byPackage[pkg];
      const b = reg.byPackage[pkg];
      a.PD += b.PD; a.FS += b.FS; a.CD += b.CD; a.total += b.total;
      t.codes.upgrades.byPackage[pkg] += m.codes.upgrades.byPackage[pkg];
      const s = t.smbDistribution.byPackage[pkg];
      const ms = m.smbDistribution.byPackage[pkg];
      for (const k of Object.keys(s)) s[k] += ms[k];
    }
    for (const type of INCOME_TYPES) {
      const a = t.income.byType[type.key];
      const b = m.income.byType[type.key];
      a.amount += b.amount; a.credits += b.credits; a.earners += b.earners;
    }
  }
  delete t.month;
  finalizeMoney(t);
  finalizeAverages(t);
  return t;
}

/**
 * @param {{from: string, to: string}} params YYYY-MM each
 * @param {{query: Function}} [conn] optional; defaults to the shared pool
 */
async function buildIncomeReleaseReport(params, conn) {
  const range = resolveRange(params); // throws before any DB access
  const db = conn || getPool();
  const queries = buildQueries(range);
  const entries = Object.entries(queries);
  // Sequential: one pooled connection, bounded load on a live DB.
  const rows = {};
  for (const [name, q] of entries) {
    const [result] = await db.query(q.sql, q.params);
    rows[name] = result;
  }
  return shapeReport(range, rows);
}

// ---- workbook ----------------------------------------------------------------

const NOTES = [
  'Source: income figures are credits recorded in payouthistorytab (the authoritative credit ledger). A credit is counted only when that income column is greater than 0.',
  'Months are Manila months. Legacy rows (before 2026-06-01) are stored in Manila time; Node-era rows are stored in UTC and are shifted +8 hours before bucketing.',
  'Registrations/package value are by JOINING package (usertab.accttype). CD codes are credit, not cash: package value counts them at full face value.',
  'Ranking (income 6) is normally 0 because rank cash is handed over physically and is never credited to the wallet.',
  'Legacy SMB history: members earned much of their Sales Match Bonus under the old PHP system. Only credits recorded in payouthistorytab appear here, so months before mid-2026 may differ from what members remember.',
  'SMB Distribution counts members by CURRENT package who were registered on or before the month end, split by number of SMB credit rows received in that month. Credits are rows, not matched pairs.',
  'Repurchase value is catalog SRP x number of codes used (Node-era rows carry no amount). Points are the incentive points recorded.',
  'Repurchases include voucher availments, which are recorded as product redemptions. Rows whose product has no catalog price are counted under "Repurchases Without Price" instead of being valued at 0.',
  'Registration months use the same Manila shift as income (Node-era datereg is stored in UTC). "Credit holders outside base" = members with SMB credits who have no registration date or registered after that month; they are excluded from the 0-credit count.',
  'Earner and member figures in total rows are member-months (a member earning in 3 months counts 3 times).',
  'Averages are blank when the denominator is zero. Payout ratio = total income released / package value of registrations in the same month.',
];

function styleHeader(ws, colCount) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: { row: 1, column: colCount } };
}

const pkgName = (t) => ACCOUNT_TYPES[t];

function summaryRow(label, m) {
  const row = {
    month: label,
    regTotal: m.codes.registrations.total,
    regValue: m.codes.registrations.packageValue,
    upgrades: m.codes.upgrades.total,
    repurchases: m.codes.repurchases.total,
    repAmount: m.codes.repurchases.amount,
    repUnpriced: m.codes.repurchases.unpriced,
    regOther: m.codes.registrations.otherAccountType,
    incomeTotal: m.income.total,
    earners: m.income.earners,
    perReg: m.averages.incomePerRegistration,
    perEarner: m.averages.incomePerEarner,
    ratio: m.averages.payoutRatio,
  };
  for (const t of PACKAGE_TYPES) {
    const c = m.codes.registrations.byPackage[t];
    row[`reg_${t}`] = c.total;
    row[`regmix_${t}`] = `PD ${c.PD} / FS ${c.FS} / CD ${c.CD}`;
    row[`up_${t}`] = m.codes.upgrades.byPackage[t];
  }
  for (const t of INCOME_TYPES) {
    row[`inc_${t.key}`] = m.income.byType[t.key].amount;
    row[`cr_${t.key}`] = m.income.byType[t.key].credits;
  }
  return row;
}

function buildIncomeReleaseWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NOGATU Alliance Admin';
  wb.created = new Date();

  const summary = wb.addWorksheet('Monthly Summary');
  const cols = [{ header: 'Month', key: 'month', width: 12 }];
  cols.push({ header: 'Registrations', key: 'regTotal', width: 15 });
  for (const t of PACKAGE_TYPES) cols.push({ header: `Reg ${pkgName(t)}`, key: `reg_${t}`, width: 12 });
  for (const t of PACKAGE_TYPES) cols.push({ header: `Reg ${pkgName(t)} PD/FS/CD`, key: `regmix_${t}`, width: 24 });
  cols.push({ header: 'Package Value (PHP)', key: 'regValue', width: 20 });
  cols.push({ header: 'Upgrades', key: 'upgrades', width: 11 });
  for (const t of PACKAGE_TYPES) cols.push({ header: `Upg to ${pkgName(t)}`, key: `up_${t}`, width: 14 });
  cols.push({ header: 'Registrations (non-package type)', key: 'regOther', width: 31 });
  cols.push({ header: 'Repurchase Codes', key: 'repurchases', width: 17 });
  cols.push({ header: 'Repurchase SRP (PHP)', key: 'repAmount', width: 21 });
  cols.push({ header: 'Repurchases Without Price', key: 'repUnpriced', width: 25 });
  for (const t of INCOME_TYPES) {
    cols.push({ header: `${t.label} (PHP)`, key: `inc_${t.key}`, width: 22 });
    cols.push({ header: `${t.label} credits`, key: `cr_${t.key}`, width: 18 });
  }
  cols.push({ header: 'Total Income (PHP)', key: 'incomeTotal', width: 20 });
  cols.push({ header: 'Earners', key: 'earners', width: 10 });
  cols.push({ header: 'Income / Registration', key: 'perReg', width: 22 });
  cols.push({ header: 'Income / Earner', key: 'perEarner', width: 18 });
  cols.push({ header: 'Payout Ratio', key: 'ratio', width: 14 });
  summary.columns = cols;
  // The ratio is stored as a fraction; without a format Excel shows 0.447 instead of 44.7%.
  summary.getColumn('ratio').numFmt = '0.0%';
  for (const c of cols) {
    if (/\(PHP\)/.test(c.header) || c.key === 'perReg' || c.key === 'perEarner') {
      summary.getColumn(c.key).numFmt = '#,##0.00';
    }
  }
  for (const m of report.months) summary.addRow(summaryRow(m.month, m));
  summary.addRow(summaryRow('TOTAL', report.totals)).font = { bold: true };
  styleHeader(summary, cols.length);

  const smb = wb.addWorksheet('SMB Distribution');
  smb.columns = [
    { header: 'Month', key: 'month', width: 12 },
    { header: 'Package (current)', key: 'pkg', width: 20 },
    { header: 'Members', key: 'members', width: 12 },
    { header: '0 SMB credits', key: 'zero', width: 15 },
    { header: '1-2 SMB credits', key: 'oneToTwo', width: 17 },
    { header: '3-4 SMB credits', key: 'threeToFour', width: 17 },
    { header: '5+ SMB credits', key: 'fivePlus', width: 16 },
    { header: 'Credit holders outside base', key: 'creditMembersOutsideBase', width: 27 },
  ];
  for (const m of [...report.months, { ...report.totals, month: 'TOTAL (member-months)' }]) {
    for (const t of PACKAGE_TYPES) {
      smb.addRow({ month: m.month, pkg: pkgName(t), ...m.smbDistribution.byPackage[t] });
    }
  }
  styleHeader(smb, 7);

  const notes = wb.addWorksheet('Notes');
  notes.columns = [{ header: 'Notes', key: 'note', width: 140 }];
  for (const n of NOTES) notes.addRow({ note: n }).alignment = { wrapText: true, vertical: 'top' };
  styleHeader(notes, 1);

  return wb;
}

module.exports = {
  buildIncomeReleaseReport,
  buildIncomeReleaseWorkbook,
  resolveRange,
  InvalidRangeError,
  PAYOUT_MONTH_SQL,
  SELECT_COUNT,
  MAX_MONTHS,
};
