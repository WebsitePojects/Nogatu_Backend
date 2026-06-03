function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);
  if (/["\r\n,]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function inferHeaders(rows = []) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

function appendRow(lines, values = []) {
  lines.push(values.map(escapeCsvValue).join(','));
}

function buildSectionedCsv(sections = []) {
  const lines = [];
  for (const section of sections) {
    const rows = Array.isArray(section?.rows) ? section.rows : [];
    const headers = Array.isArray(section?.headers) && section.headers.length
      ? section.headers
      : inferHeaders(rows);

    if (section?.title) {
      appendRow(lines, [section.title]);
    }

    if (headers.length) {
      appendRow(lines, headers);
      for (const row of rows) {
        appendRow(lines, headers.map((header) => row?.[header]));
      }
    }

    lines.push('');
  }

  return `\uFEFF${lines.join('\r\n').replace(/\r\n$/, '')}`;
}

function normalizeCsvFilename(filename = 'report') {
  const base = String(filename || 'report').trim().replace(/\.csv$/i, '') || 'report';
  return `${base}.csv`;
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${normalizeCsvFilename(filename)}"`);
  res.send(csv);
}

module.exports = {
  buildSectionedCsv,
  sendCsv,
};
