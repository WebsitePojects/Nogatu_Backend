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

/**
 * One-account-policy duplicate gate. The ONLY function the registration flow
 * calls to decide whether a new registrant collides with an existing member.
 *
 * Rules (management-specified, exactly these four, no more):
 *   R1 TIN              - normalized TINs equal, both non-empty, neither a "zero TIN".
 *   R2 EXACT NAME        - normalized first+last equal in the SAME order (unchanged
 *                          from the pre-existing behavior: plain cleaned strings,
 *                          NOT suffix-stripped, so "Cruz Jr" != "Cruz").
 *   R3 SWITCHED NAME      - the same two name tokens with order swapped, detected via
 *                          normalizeIdentityName()'s sorted `bareFingerprint`. Guarded
 *                          with an explicit suffix match (see below) even though the
 *                          spec's minimum ask didn't call it out, because
 *                          bareFingerprint strips the suffix off the "last" token
 *                          before sorting -- without the guard, "John Cruz Jr" and
 *                          "Cruz John" (no suffix) would collide on bareFingerprint
 *                          alone. isCloseNameMatch() already carries this exact guard
 *                          for fuzzy matches; R3 mirrors it for consistency.
 *   R4 SIMILAR NAME + DOB  - isCloseNameMatch() true AND both DOBs non-empty and equal.
 *                          Fuzzy similarity ALONE never blocks (see isCloseNameMatch's
 *                          own suffix + threshold guards) -- only in combination with a
 *                          matching DOB, so unrelated common names (two "Maria Santos")
 *                          are not falsely blocked.
 *
 * Every other signal (email, contact number, address) is informational only
 * (see matchedSignalsForCandidate) and never gates registration on its own --
 * confirmed shared-phone-number groups (families/teams registering under one
 * leader's number) must not be blocked.
 */
async function evaluateDuplicateIdentity(input, conn = pool) {
  const normalizedTin = normalizeTinValue(input.tin);
  const tinIsUsable = Boolean(normalizedTin) && !isZeroTin(normalizedTin);

  const inputFirstRaw = String(input.firstname || '').trim();
  const inputLastRaw = String(input.lastname || '').trim();
  const inputDob = normalizeDob(input.dob);
  const dobIsUsable = Boolean(inputDob);

  // R2 uses the ORIGINAL plain-cleaned (non-suffix-stripped) key, preserving
  // exact pre-existing behavior. R3/R4 use normalizeIdentityName's richer,
  // suffix-aware fingerprint/comparable fields.
  const inputFirstKey = normalizeNameKey(input.firstname);
  const inputLastKey = normalizeNameKey(input.lastname);
  const inputNameKey = [inputFirstKey, inputLastKey].filter(Boolean).join('|');

  const inputIdentity = normalizeIdentityName({
    firstname: input.firstname,
    lastname: input.lastname,
    middlename: input.middlename,
  });

  // Optional, purely additive, opt-in safety valve: if a caller ever reuses
  // this gate for an EDIT flow (not today's registration call site, which
  // never passes it), `excludeUid` prevents a member from colliding with
  // their own existing row. Absent (the current behavior), it is a no-op.
  const excludeUid = input.excludeUid != null ? Number(input.excludeUid) : null;

  const notBlocked = (reason) => ({
    allowed: true,
    matchedUid: null,
    matchedUsername: null,
    matchedName: null,
    normalizedName: inputNameKey,
    matchedSignals: [],
    rule: null,
    reason,
  });

  // --- Candidate narrowing --------------------------------------------------
  // Provably complete for R1-R4 (SQL only narrows; JS below is the precise,
  // authoritative comparison):
  //   - R1 needs rows sharing the tin                          -> `tin = ?`
  //   - R2 and R3 both need rows where EITHER name column equals EITHER input
  //     name token: checking both columns (firstname, lastname) against both
  //     tokens (input first, input last) is exactly what catches a switched
  //     registration, since the switched candidate's firstname equals the
  //     input's lastname (and vice versa)          -> `firstname/lastname IN (token1, token2)`
  //   - R4 additionally REQUIRES an equal dob (not just a similar name), so
  //     every row R4 could possibly fire on already has a matching dob, and
  //     is therefore already pulled in by the dob arm below. A fuzzy-similar
  //     name with a DIFFERENT (or empty) dob can never satisfy R4, so it
  //     needs no arm of its own                     -> `dob = ?`
  // Each arm is skipped when its own input is empty/unusable; if ALL arms
  // are empty, nothing in memberstab could possibly trip R1-R4, so we return
  // allowed:true without touching the DB at all.
  const conditions = [];
  const params = [];

  if (tinIsUsable) {
    conditions.push('tin = ?');
    params.push(normalizedTin);
  }
  if (dobIsUsable) {
    conditions.push('dob = ?');
    params.push(String(input.dob).trim());
  }
  const nameTokens = [inputFirstRaw, inputLastRaw].filter(Boolean);
  if (nameTokens.length > 0) {
    // LOWER() on both sides so a case-differing legacy row (e.g. stored in a
    // case-sensitive collation) isn't silently dropped by the narrowing step
    // -- this can only make the candidate set LARGER, never smaller.
    const firstPlaceholders = nameTokens.map(() => 'LOWER(?)').join(', ');
    const lastPlaceholders = nameTokens.map(() => 'LOWER(?)').join(', ');
    conditions.push(`LOWER(firstname) IN (${firstPlaceholders})`);
    params.push(...nameTokens);
    conditions.push(`LOWER(lastname) IN (${lastPlaceholders})`);
    params.push(...nameTokens);
  }

  if (conditions.length === 0) {
    return notBlocked('empty-input');
  }

  let whereClause = conditions.join(' OR ');
  if (excludeUid != null && Number.isFinite(excludeUid) && excludeUid > 0) {
    whereClause = `(${whereClause}) AND uid <> ?`;
    params.push(excludeUid);
  }

  const [rows] = await conn.query(
    `SELECT uid, username, firstname, lastname, middlename, tin, email, contactnos, dob, address
       FROM memberstab
      WHERE ${whereClause}`,
    params
  );

  for (const row of rows) {
    if (excludeUid != null && Number(row.uid) === excludeUid) continue;

    const existingTin = normalizeTinValue(row.tin);
    const existingFirstKey = normalizeNameKey(row.firstname);
    const existingLastKey = normalizeNameKey(row.lastname);
    const existingNameKey = [existingFirstKey, existingLastKey].filter(Boolean).join('|');

    const existingIdentity = normalizeIdentityName({
      firstname: row.firstname,
      lastname: row.lastname,
      middlename: row.middlename,
    });

    // R1
    const tinMatches = tinIsUsable
      && Boolean(existingTin) && !isZeroTin(existingTin)
      && normalizedTin === existingTin;

    // R2 - unchanged from today: plain order-sensitive key equality.
    const exactNameMatches = Boolean(inputNameKey)
      && Boolean(existingNameKey)
      && inputNameKey === existingNameKey;

    // R3 - same two tokens, order swapped. Guarded on suffix equality (see
    // the function-level comment) so a Jr/Sr pair can't collide here either.
    const switchedNameMatches = !exactNameMatches
      && Boolean(inputIdentity.bareFingerprint)
      && inputIdentity.bareFingerprint === existingIdentity.bareFingerprint
      && inputIdentity.suffix === existingIdentity.suffix;

    // dob signal, independent of which rule (if any) ends up firing.
    const existingDob = normalizeDob(row.dob);
    const dobMatches = dobIsUsable && Boolean(existingDob) && inputDob === existingDob;

    // R4 - fuzzy name similarity, only evaluated/reported when it isn't
    // already an exact or switched match, combined with a real dob match.
    const similarNameMatches = !exactNameMatches
      && !switchedNameMatches
      && isCloseNameMatch(inputIdentity, existingIdentity);

    let rule = null;
    if (tinMatches) rule = 'tin';
    else if (exactNameMatches) rule = 'name_exact';
    else if (switchedNameMatches) rule = 'name_switched';
    else if (similarNameMatches && dobMatches) rule = 'name_similar_dob';

    if (!rule) continue;

    const signalFlags = {
      tin: tinMatches,
      name_exact: exactNameMatches,
      name_switched: switchedNameMatches,
      name_similar: similarNameMatches,
      dob: dobMatches,
    };
    const matchedSignals = ['tin', 'name_exact', 'name_switched', 'name_similar', 'dob']
      .filter((key) => signalFlags[key]);

    const matchedName = [row.firstname, row.lastname]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(' ') || null;

    const reasonByRule = {
      tin: 'tin-match',
      name_exact: 'name-exact-match',
      name_switched: 'name-switched-match',
      name_similar_dob: 'name-similar-dob-match',
    };

    return {
      allowed: false,
      matchedUid: Number(row.uid || 0),
      matchedUsername: row.username != null ? String(row.username) : null,
      matchedName,
      normalizedName: inputNameKey,
      matchedSignals,
      rule,
      reason: reasonByRule[rule],
    };
  }

  return notBlocked('no-duplicate-match');
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
