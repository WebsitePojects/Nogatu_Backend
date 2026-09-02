const { pool } = require('../config/database');
const { normalizeEmail } = require('../utils/email');
const { isZeroTin } = require('../utils/tin');

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

// A shared name is NOT evidence of a shared identity.
//
// Philippine name collisions are ordinary: production already holds 118 first+last
// name groups covering 240 members, every one of them registered legitimately.
// Blocking on the name alone would have rejected 122 of those existing members, and
// on 2026-08-27 it blocked a real paid Gold registration -- Ruben Abayan Ramos, whose
// only "match" was the unrelated Ruben Dinglasan Ramos (uid 2516680), a record that
// carries no dob, email, contact number or TIN to compare against at all.
//
// So an exact name match now blocks ONLY when a second, independent identifier also
// agrees. A genuine re-registration nearly always repeats a birthday, a phone number
// or an email; two different people who merely share a name repeat none of them.
//
// Address is deliberately NOT corroborating: relatives share both a surname and a
// household, so name + address is the pairing most likely to reject two real people.
const CORROBORATING_SIGNALS = ['tin', 'dob', 'email', 'contactno'];

function matchedSignalsForCandidate(input, candidate) {
  const matched = [];

  const inputTinVal = normalizeTinValue(input.tin);
  const candidateTinVal = normalizeTinValue(candidate.tin);
  if (inputTinVal && !isZeroTin(inputTinVal) && candidateTinVal && !isZeroTin(candidateTinVal) && inputTinVal === candidateTinVal) {
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
    const existingFirst = normalizeNameKey(row.firstname);
    const existingLast = normalizeNameKey(row.lastname);
    const existingNameKey = [existingFirst, existingLast].filter(Boolean).join('|');

    // Every independent identifier that agrees between the applicant and this row.
    // matchedSignalsForCandidate already guards each signal on the INPUT value being
    // non-empty, so two blank fields never count as agreeing with each other.
    const corroborating = matchedSignalsForCandidate(input, row)
      .filter((signal) => CORROBORATING_SIGNALS.includes(signal));

    const tinMatches = corroborating.includes('tin');
    const exactNameMatches = Boolean(inputNameKey)
      && Boolean(existingNameKey)
      && inputNameKey === existingNameKey;

    // A TIN is a government-issued unique identifier, so it stands alone.
    // A name needs a second identifier to agree before it blocks anyone.
    const blockedByTin = tinMatches;
    const blockedByName = exactNameMatches && corroborating.length > 0;
    if (!blockedByTin && !blockedByName) continue;

    const matchedSignals = [];
    if (tinMatches) matchedSignals.push('tin');
    if (exactNameMatches) matchedSignals.push('firstname_lastname');
    for (const signal of corroborating) {
      if (signal !== 'tin') matchedSignals.push(signal);
    }

    return {
      allowed: false,
      matchedUid: Number(row.uid || 0),
      normalizedName: inputNameKey,
      matchedSignals,
      corroboratingSignals: corroborating,
      reason: blockedByTin && exactNameMatches
        ? 'tin-and-firstname-lastname-match'
        : blockedByTin
          ? 'tin-match'
          : 'firstname-lastname-with-corroborating-signal-match',
    };
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
