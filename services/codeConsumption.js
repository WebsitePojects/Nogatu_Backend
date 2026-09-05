/**
 * Second gate on activation-code consumption.
 *
 * Incident, September 2026. Production held 28 activation codes whose status still
 * read "Released" (available) even though each had already registered a member back
 * in 2025. The legacy PHP registration flow stamped `codestab.dateused` but never
 * advanced `codestab.codestatus` to 2, so the code stayed selectable forever. One of
 * them, PDEQ8AXFUNN5, was handed out and used a second time on 10 August 2026 -- two
 * live accounts, one paid package.
 *
 * `codestatus = 1` alone is therefore NOT proof that a code is unused. A second,
 * independent condition is required before a code may be consumed:
 *
 *   1. codestatus = 1                  (the code is released and available)
 *   2. the code has not already been consumed by anybody
 *
 * Condition 2 is evidenced two ways, and both are checked because they fail in
 * different directions:
 *
 *   `dateused`                 - stamped by EVERY consumption path, legacy and current
 *                                (registration, upgrade, repurchase). This evidence is
 *                                ROW-SPECIFIC, so it is always safe. Measured against
 *                                the production snapshot, within released codes it
 *                                matched "already tied to a member" 29 times out of 29,
 *                                with no false positives. It costs nothing: the column
 *                                is already on the row that was just fetched.
 *
 *   `usertab.activationcode`   - the member-side record of the same fact. It survives
 *                                even if a future write clears or overwrites `dateused`,
 *                                which is exactly what happened to PDEQ8AXFUNN5 when the
 *                                current system re-stamped it in August 2026 and erased
 *                                the 2025 marker.
 *
 * ⚠️ Why the member-side evidence is COUNTED rather than merely looked up.
 * `codestab.code` has no unique constraint and production genuinely holds 7 duplicate
 * code strings (legacy twins, every one already codestatus = 2). A member row records
 * only the code STRING, never which physical `codestab` row was consumed, so a bare
 * "does any member hold this string" test would permanently refuse a real, paid-for,
 * never-used twin the moment its sibling was consumed -- a blocked paying customer with
 * no override path. Comparing the number of members holding the string against the
 * number of physical rows carrying it keeps the normal case (one row, one member)
 * refusing, while letting a genuinely free twin through, where its own row-specific
 * `dateused` remains the guard. Verified against production: zero duplicate strings
 * currently have an available twin, so this is a latent vector, not a live one.
 *
 * Read-only. Nothing here writes, and no money table is touched.
 */

/**
 * Has this specific code row already been consumed?
 *
 * MySQL zero-dates and empty strings are NOT evidence of use -- they are the absence
 * of a value on a legacy row, and treating them as "used" would refuse perfectly good
 * codes. Fail open here; the member-side check below is the half that fails closed.
 * mysql2 parses a zero DATETIME through `new Date(str)`, which yields an Invalid Date,
 * so that case arrives here as a Date whose time is NaN.
 */
function isCodeAlreadyConsumed(dateused) {
  if (dateused === null || dateused === undefined) return false;

  if (dateused instanceof Date) {
    return !Number.isNaN(dateused.getTime());
  }

  const text = String(dateused).trim();
  if (!text) return false;
  if (text.startsWith('0000-00-00')) return false;
  return true;
}

/**
 * Member-side evidence for one code string, in a single round trip.
 *
 * `registeredUid` is ordered so the value reported to support is deterministic when a
 * duplicate string ties to more than one member.
 */
async function findMemberRegistrationEvidence(conn, code) {
  const value = String(code || '').trim();
  if (!value) return { membersRegistered: 0, physicalRows: 0, registeredUid: null };

  const [rows] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM usertab u WHERE u.activationcode = ?)  AS membersRegistered,
       (SELECT COUNT(*) FROM codestab c WHERE c.code = ?)           AS physicalRows,
       (SELECT u2.uid FROM usertab u2 WHERE u2.activationcode = ?
         ORDER BY u2.uid LIMIT 1)                                   AS registeredUid`,
    [value, value, value]
  );

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { membersRegistered: 0, physicalRows: 0, registeredUid: null };

  return {
    membersRegistered: Number(row.membersRegistered || 0),
    physicalRows: Number(row.physicalRows || 0),
    registeredUid: row.registeredUid == null ? null : Number(row.registeredUid),
  };
}

/**
 * True when every physical code row carrying this string is already spoken for.
 *
 * `membersRegistered > 0` matters: without it a string carried by zero members and
 * zero rows would satisfy `0 >= 0` and refuse a perfectly good code.
 */
function everyPhysicalRowIsSpokenFor({ membersRegistered, physicalRows }) {
  return membersRegistered > 0 && membersRegistered >= physicalRows;
}

function createCodeAlreadyUsedError(code, { registeredUid = null, evidence = 'used' } = {}) {
  const detail = evidence === 'registration'
    ? 'This activation code has already been used to register an account and cannot be used again.'
    : 'This activation code has already been used and cannot be used again.';

  const error = new Error(`${detail} Please use a different code.`);
  error.code = 'CODE_ALREADY_USED';
  error.details = {
    activationCode: String(code || ''),
    registeredUid: registeredUid === null ? null : Number(registeredUid),
    evidence,
  };
  return error;
}

/**
 * Throws when `codeRow` fails condition 2. Call it AFTER the codestatus = 1 lookup
 * and BEFORE the consuming UPDATE, inside the same transaction.
 */
async function assertCodeNotAlreadyConsumed(conn, code, codeRow) {
  const evidence = await findMemberRegistrationEvidence(conn, code);

  if (isCodeAlreadyConsumed(codeRow?.dateused)) {
    throw createCodeAlreadyUsedError(code, {
      registeredUid: evidence.registeredUid,
      evidence: 'used',
    });
  }

  if (everyPhysicalRowIsSpokenFor(evidence)) {
    throw createCodeAlreadyUsedError(code, {
      registeredUid: evidence.registeredUid,
      evidence: 'registration',
    });
  }
}

module.exports = {
  isCodeAlreadyConsumed,
  findMemberRegistrationEvidence,
  everyPhysicalRowIsSpokenFor,
  createCodeAlreadyUsedError,
  assertCodeNotAlreadyConsumed,
};
