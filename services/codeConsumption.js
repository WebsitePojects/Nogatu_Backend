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
 *                                (registration, upgrade, repurchase). Measured against
 *                                the production snapshot, within released codes this
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
 * Read-only. Nothing here writes, and no money table is touched.
 */

/**
 * Has this code already been consumed at some point?
 *
 * MySQL zero-dates and empty strings are NOT evidence of use -- they are the absence
 * of a value written by a legacy row, and treating them as "used" would refuse
 * perfectly good codes. Fail open here and let the usertab check below fail closed.
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
 * uid of the member already registered under this exact code, or null.
 * One indexed seek (see migrations/V044) on a table of a few thousand rows.
 */
async function findMemberRegisteredWithCode(conn, code) {
  const value = String(code || '').trim();
  if (!value) return null;

  const [rows] = await conn.query(
    'SELECT uid FROM usertab WHERE activationcode = ? LIMIT 1',
    [value]
  );
  return rows.length ? Number(rows[0].uid) : null;
}

function createCodeAlreadyUsedError(code, registeredUid = null) {
  const error = new Error(
    'This activation code has already been used to register an account and cannot be used again. '
    + 'Please use a different code.'
  );
  error.code = 'CODE_ALREADY_USED';
  error.details = {
    activationCode: String(code || ''),
    registeredUid: registeredUid === null ? null : Number(registeredUid),
  };
  return error;
}

/**
 * Throws when `codeRow` fails condition 2. Call it AFTER the codestatus = 1 lookup
 * and BEFORE the consuming UPDATE, inside the same transaction.
 */
async function assertCodeNotAlreadyConsumed(conn, code, codeRow) {
  if (isCodeAlreadyConsumed(codeRow?.dateused)) {
    const registeredUid = await findMemberRegisteredWithCode(conn, code);
    throw createCodeAlreadyUsedError(code, registeredUid);
  }

  const registeredUid = await findMemberRegisteredWithCode(conn, code);
  if (registeredUid) {
    throw createCodeAlreadyUsedError(code, registeredUid);
  }
}

module.exports = {
  isCodeAlreadyConsumed,
  findMemberRegisteredWithCode,
  createCodeAlreadyUsedError,
  assertCodeNotAlreadyConsumed,
};
