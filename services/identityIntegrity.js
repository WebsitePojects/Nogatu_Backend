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

function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNameKey(value) {
  return cleanNamePart(value);
}

function jaroSimilarity(aRaw, bRaw) {
  const a = String(aRaw || '');
  const b = String(bRaw || '');
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aLen = a.length;
  const bLen = b.length;
  const matchDistance = Math.floor(Math.max(aLen, bLen) / 2) - 1;

  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);
  let matches = 0;

  for (let i = 0; i < aLen; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  return (
    (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3
  );
}

function jaroWinklerSimilarity(aRaw, bRaw) {
  const a = String(aRaw || '');
  const b = String(bRaw || '');
  const jaro = jaroSimilarity(a, b);
  if (jaro <= 0) return 0;

  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxPrefix; i += 1) {
    if (a[i] !== b[i]) break;
    prefix += 1;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
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
    comparable: [first, normalizedLast].filter(Boolean).join(' ').trim(),
  };
}

function isCloseNameMatch(inputIdentity, existingIdentity) {
  if (!inputIdentity?.comparable || !existingIdentity?.comparable) return false;

  if (inputIdentity.suffix !== existingIdentity.suffix) {
    return false;
  }

  if (inputIdentity.bareFingerprint === existingIdentity.bareFingerprint) {
    return true;
  }

  const score = jaroWinklerSimilarity(inputIdentity.comparable, existingIdentity.comparable);
  return score >= 0.92;
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
  if (normalizeAddress(input.address) && normalizeAddress(input.address) === normalizeAddress(candidate.address)) {
    matched.push('address');
  }

  return matched;
}

async function evaluateDuplicateIdentity(input, conn = pool) {
  const normalizedTin = normalizeTinValue(input.tin);
  const inputFirst = normalizeNameKey(input.firstname);
  const inputLast = normalizeNameKey(input.lastname);
  const inputNameKey = [inputFirst, inputLast].filter(Boolean).join('|');

  if (!normalizedTin && !inputNameKey) {
    return {
      allowed: true,
      matchedUid: null,
      normalizedName: inputNameKey,
      matchedSignals: [],
      reason: 'empty-name',
    };
  }

  const [rows] = await conn.query(
    `SELECT uid, firstname, lastname, middlename, tin, email, contactnos, dob, address
       FROM memberstab`
  );

  for (const row of rows) {
    const existingTin = normalizeTinValue(row.tin);
    const existingFirst = normalizeNameKey(row.firstname);
    const existingLast = normalizeNameKey(row.lastname);
    const existingNameKey = [existingFirst, existingLast].filter(Boolean).join('|');
    const matchedSignals = [];

    if (normalizedTin && existingTin && normalizedTin === existingTin) {
      matchedSignals.push('tin');
    }

    if (inputNameKey && existingNameKey && inputNameKey === existingNameKey) {
      matchedSignals.push('firstname_lastname');
    }

    if (matchedSignals.length > 0) {
      return {
        allowed: false,
        matchedUid: Number(row.uid || 0),
        normalizedName: inputNameKey,
        matchedSignals,
        reason: matchedSignals.includes('tin') && matchedSignals.includes('firstname_lastname')
          ? 'tin-and-firstname-lastname-match'
          : matchedSignals.includes('tin')
            ? 'tin-match'
            : 'firstname-lastname-match',
      };
    }
  }

  return {
    allowed: true,
    matchedUid: null,
    normalizedName: inputNameKey,
    matchedSignals: [],
    reason: 'no-duplicate-match',
  };
}

module.exports = {
  KNOWN_SUFFIXES,
  normalizeIdentityName,
  jaroSimilarity,
  jaroWinklerSimilarity,
  isCloseNameMatch,
  normalizeContactNo,
  normalizeDob,
  normalizeTinValue,
  normalizeAddress,
  matchedSignalsForCandidate,
  evaluateDuplicateIdentity,
};
