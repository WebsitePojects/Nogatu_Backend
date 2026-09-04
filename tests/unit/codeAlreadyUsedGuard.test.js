/**
 * A released code that has already been consumed must be refused.
 *
 * Incident, September 2026. 28 production codes read "Released" while each had
 * already registered a member in 2025, because the legacy PHP flow stamped
 * dateused but never advanced codestatus. PDEQ8AXFUNN5 was consumed a second time
 * on 10 August 2026 off the back of that. Fixtures below are the real rows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCodeAlreadyConsumed,
  findMemberRegisteredWithCode,
  assertCodeNotAlreadyConsumed,
} = require('../../services/codeConsumption');

const connReturning = (...rows) => ({ query: async () => [rows] });
const noMemberConn = connReturning();

async function refusal(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

// --- dateused reading ------------------------------------------------------

test('a null or absent dateused is not evidence of use', () => {
  assert.equal(isCodeAlreadyConsumed(null), false);
  assert.equal(isCodeAlreadyConsumed(undefined), false);
});

test('empty and zero dates are not evidence of use', () => {
  // Legacy rows carry these instead of NULL. Treating them as used would refuse
  // perfectly good codes; the usertab check is what fails closed.
  assert.equal(isCodeAlreadyConsumed(''), false);
  assert.equal(isCodeAlreadyConsumed('   '), false);
  assert.equal(isCodeAlreadyConsumed('0000-00-00 00:00:00'), false);
  assert.equal(isCodeAlreadyConsumed(new Date('not a date')), false);
});

test('a real dateused, as a Date or a string, is evidence of use', () => {
  assert.equal(isCodeAlreadyConsumed(new Date('2025-07-22T15:02:18')), true);
  assert.equal(isCodeAlreadyConsumed('2025-07-22 15:02:18'), true);
});

// --- the incident itself ---------------------------------------------------

test('CDBCXSG4QPSW: released, but stamped used in 2025 and tied to a member', async () => {
  const codeRow = {
    id: 105, code: 'CDBCXSG4QPSW', producttype: 10, codestatus: 1,
    dateused: new Date('2025-07-22T15:02:18'),
    dategen: new Date('2025-07-22T06:16:59'),
  };

  const err = await refusal(() => assertCodeNotAlreadyConsumed(
    connReturning({ uid: 1360539 }), 'CDBCXSG4QPSW', codeRow
  ));

  assert.ok(err, 'an already-consumed code must be refused');
  assert.equal(err.code, 'CODE_ALREADY_USED');
  assert.equal(err.details.registeredUid, 1360539);
});

test('PDEQ8AXFUNN5: refused even after its 2025 dateused was overwritten', async () => {
  // The current system re-stamped dateused to 2026-08-10 when the code was used a
  // second time, erasing the original marker. The member-side record is what
  // survives that, which is why both conditions are checked and not just one.
  const codeRow = {
    id: 3490, code: 'PDEQ8AXFUNN5', producttype: 10, codestatus: 1, dateused: null,
  };

  const err = await refusal(() => assertCodeNotAlreadyConsumed(
    connReturning({ uid: 6129725 }), 'PDEQ8AXFUNN5', codeRow
  ));

  assert.ok(err, 'a code already recorded against a member must be refused');
  assert.equal(err.code, 'CODE_ALREADY_USED');
  assert.equal(err.details.registeredUid, 6129725);
});

test('a used-date alone is enough, with no member row to find', async () => {
  // Upgrade and repurchase stamp dateused without writing usertab.activationcode.
  const err = await refusal(() => assertCodeNotAlreadyConsumed(
    noMemberConn, 'PDVMSN6BZBQE', { dateused: '2025-07-30 18:11:33' }
  ));

  assert.ok(err);
  assert.equal(err.code, 'CODE_ALREADY_USED');
  assert.equal(err.details.registeredUid, null, 'reports honestly that no member row was found');
});

// --- a genuinely unused code must still pass -------------------------------

test('a genuinely available code passes both conditions', async () => {
  await assertCodeNotAlreadyConsumed(
    noMemberConn, 'PDXJE9ESLQUZ',
    { id: 22600, code: 'PDXJE9ESLQUZ', producttype: 10, codestatus: 1, dateused: null }
  );
});

test('14,693 released-and-unused production codes are shaped like this one', async () => {
  // Guards against a fix that closes the hole by refusing everything.
  for (const dateused of [null, undefined, '', '0000-00-00 00:00:00']) {
    await assertCodeNotAlreadyConsumed(noMemberConn, 'PDSOMECODE01', { dateused });
  }
});

// --- the lookup ------------------------------------------------------------

test('findMemberRegisteredWithCode returns the uid, or null', async () => {
  assert.equal(await findMemberRegisteredWithCode(connReturning({ uid: 42 }), 'PDX'), 42);
  assert.equal(await findMemberRegisteredWithCode(noMemberConn, 'PDX'), null);
});

test('a blank code is never looked up', async () => {
  const conn = { query: async () => { throw new Error('must not query on a blank code'); } };
  assert.equal(await findMemberRegisteredWithCode(conn, ''), null);
  assert.equal(await findMemberRegisteredWithCode(conn, null), null);
});

test('the lookup filters on activationcode and is bounded', async () => {
  let sql = null;
  let params = null;
  await findMemberRegisteredWithCode({
    query: async (q, p) => { sql = q; params = p; return [[]]; },
  }, 'PDABC123');

  assert.match(sql, /FROM usertab/i);
  assert.match(sql, /activationcode = \?/i);
  assert.match(sql, /LIMIT 1/i);
  assert.deepEqual(params, ['PDABC123'], 'parameterised, never interpolated');
});

// --- the guard is actually wired into the consumption path -----------------

const {
  consumeActivationCodeForRegistration,
} = require('../../services/registration');

test('registration refuses an already-used code and issues NO consuming UPDATE', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM codestab/i.test(sql)) {
        return [[{
          id: 105, code: 'CDBCXSG4QPSW', uid: 1360539, producttype: 10, codetype: 3,
          productamount: 2500, binarypoints: 250, directreferral: 250,
          codestatus: 1, dateused: new Date('2025-07-22T15:02:18'),
        }]];
      }
      if (/FROM usertab/i.test(sql)) return [[{ uid: 1360539 }]];
      return [{ affectedRows: 1 }];
    },
  };

  const err = await refusal(() => consumeActivationCodeForRegistration(conn, {
    activationCode: 'CDBCXSG4QPSW',
  }));

  assert.ok(err, 'the already-used code must be refused');
  assert.equal(err.code, 'CODE_ALREADY_USED');

  const consumed = calls.some((c) => /UPDATE\s+codestab/i.test(c.sql));
  assert.equal(consumed, false, 'the code must NOT be consumed once it is refused');
});

test('registration still consumes a genuinely available code', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM codestab/i.test(sql)) {
        return [[{
          id: 22600, code: 'PDXJE9ESLQUZ', uid: 0, producttype: 10, codetype: 1,
          productamount: 2500, codestatus: 1, dateused: null,
        }]];
      }
      if (/FROM usertab/i.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };

  const codeData = await consumeActivationCodeForRegistration(conn, {
    activationCode: 'PDXJE9ESLQUZ',
  });

  assert.equal(codeData.producttype, 10);
  assert.ok(calls.some((c) => /UPDATE\s+codestab/i.test(c.sql)), 'the code must be consumed');
});
