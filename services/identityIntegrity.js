const { pool } = require('../config/database');
const { normalizeEmail } = require('../utils/email');

const KNOWN_SUFFIXES = [
  'jr', 'jr.', 'sr', 'sr.',
  'ii', 'iii', 'iv', 'v', 'vi',
];

function cleanNamePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeContactNo(value) {
  return String(value || '').replace(/\D/g, '').trim();
}

function normalizeDob(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTinValue(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function pickSuffix(parts) {
  if (parts.length === 0) return { suffix: '', remainder: parts };
  const last = parts[parts.length - 1];
  if (KNOWN_SUFFIXES.includes(last)) {
    return { suffix: last.replace(/\./g, ''), remainder: parts.slice(0, -1) };
  }
  return { suffix: '', remainder: parts };
}

function normalizeIdentityName({ firstname, lastname, middlename }) {
  const first = cleanNamePart(firstname);
  const last = cleanNamePart(lastname);
  const middle = cleanNamePart(middlename);

  const baseParts = [first, last].filter(Boolean).sort();
  const lastParts = last.split(' ').filter(Boolean);
  const { suffix, remainder } = pickSuffix(lastParts);
  const normalizedLast = remainder.join(' ') || last;

  const sorted = [first, normalizedLast].filter(Boolean).sort();
  const middleInitial = middle ? middle[0] : '';

  return {
    first,
    last: normalizedLast,
    middle,
    middleInitial,
    suffix,
    fingerprint: `${sorted.join('')}:${middleInitial}:${suffix}`,
    bareFingerprint: sorted.join(''),
  };
}

function matchedSignalsForCandidate(input, candidate) {
  const matched = [];

  if (normalizeTinValue(input.tin) && normalizeTinValue(input.tin) === normalizeTinValue(candidate.tin)) {
    matched.push('tin');
  }
  if (normalizeDob(input.dob) && normalizeDob(input.dob) === normalizeDob(candidate.dob)) {
    matched.push('dob');
  }
  if (normalizeEmail(input.email) && normalizeEmail(input.email) === normalizeEmail(candidate.email)) {
    matched.push('email');
  }
  if (normalizeContactNo(input.contactno) && normalizeContactNo(input.contactno) === normalizeContactNo(candidate.contactnos)) {
    matched.push('contactno');
  }

  return matched;
}

async function evaluateDuplicateIdentity(input, conn = pool) {
  const normalizedInput = normalizeIdentityName(input);
  if (!normalizedInput.bareFingerprint) {
    return {
      allowed: true,
      matchedUid: null,
      normalizedName: '',
      matchedSignals: [],
      reason: 'empty-name',
    };
  }

  const [rows] = await conn.query(
    `SELECT uid, firstname, lastname, middlename, tin, email, contactnos, dob
       FROM memberstab`
  );

  for (const row of rows) {
    const normalizedExisting = normalizeIdentityName(row);
    if (normalizedExisting.fingerprint !== normalizedInput.fingerprint) {
      continue;
    }

    const matchedSignals = matchedSignalsForCandidate(input, row);
    if (matchedSignals.length > 0) {
      return {
        allowed: false,
        matchedUid: Number(row.uid || 0),
        normalizedName: normalizedInput.bareFingerprint,
        matchedSignals,
        reason: 'name-plus-strong-signal-match',
      };
    }
  }

  return {
    allowed: true,
    matchedUid: null,
    normalizedName: normalizedInput.bareFingerprint,
    matchedSignals: [],
    reason: 'name-only-match-not-blocked',
  };
}

module.exports = {
  KNOWN_SUFFIXES,
  normalizeIdentityName,
  normalizeContactNo,
  normalizeDob,
  normalizeTinValue,
  matchedSignalsForCandidate,
  evaluateDuplicateIdentity,
};
