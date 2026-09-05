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
  findMemberRegistrationEvidence,
  assertCodeNotAlreadyConsumed,
} = require('../../services/codeConsumption');

// The guard asks ONE counting question. `registered` is how many members hold the code
// string; `physicalRows` is how many codestab rows carry it (>1 only for legacy twins).
const evidenceConn = ({ registered = 0, physicalRows = 1, uid = null } = {}) => ({
  query: async () => [[{ membersRegistered: registered, physicalRows, registeredUid: uid }]],
});
const noMemberConn = evidenceConn();

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
    evidenceConn({ registered: 1, uid: 1360539 }), 'CDBCXSG4QPSW', codeRow
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
    evidenceConn({ registered: 1, uid: 6129725 }), 'PDEQ8AXFUNN5', codeRow
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

test('findMemberRegistrationEvidence returns the uid, or null', async () => {
  assert.equal((await findMemberRegistrationEvidence(evidenceConn({ registered: 1, uid: 42 }), 'PDX')).registeredUid, 42);
  assert.equal((await findMemberRegistrationEvidence(noMemberConn, 'PDX')).registeredUid, null);
});

test('a blank code is never looked up', async () => {
  const conn = { query: async () => { throw new Error('must not query on a blank code'); } };
  assert.equal((await findMemberRegistrationEvidence(conn, '')).registeredUid, null);
  assert.equal((await findMemberRegistrationEvidence(conn, null)).registeredUid, null);
});

test('the lookup filters on activationcode and is bounded', async () => {
  let sql = null;
  let params = null;
  await findMemberRegistrationEvidence({
    query: async (q, p) => { sql = q; params = p; return [[{}]]; },
  }, 'PDABC123');

  assert.match(sql, /FROM usertab/i);
  assert.match(sql, /activationcode = \?/i);
  assert.match(sql, /LIMIT 1/i);
  assert.match(sql, /FROM codestab/i);
  assert.deepEqual(params, ['PDABC123', 'PDABC123', 'PDABC123'],
    'parameterised, never interpolated');
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

// --- the twin defect the falsification pass found -------------------------

test('a never-used twin of a duplicate code string is NOT refused', async () => {
  // codestab.code has no unique constraint and production holds 7 duplicate strings.
  // A member row records only the STRING, never which physical row was consumed, so a
  // bare "does any member hold this string" test would permanently refuse a real,
  // paid-for, never-used twin the moment its sibling was used. That is a blocked
  // paying customer with no override, so it must not happen.
  await assertCodeNotAlreadyConsumed(
    evidenceConn({ registered: 1, physicalRows: 2, uid: 4242 }),
    'PDDUPE7X9K2M',
    { id: 99999, code: 'PDDUPE7X9K2M', codestatus: 1, dateused: null }
  );
});

test('a duplicate string with BOTH twins spoken for is still refused', async () => {
  const err = await refusal(() => assertCodeNotAlreadyConsumed(
    evidenceConn({ registered: 2, physicalRows: 2, uid: 4242 }),
    'PDDUPE7X9K2M',
    { id: 99999, code: 'PDDUPE7X9K2M', codestatus: 1, dateused: null }
  ));
  assert.ok(err, 'no free twin remains, so it must refuse');
  assert.equal(err.code, 'CODE_ALREADY_USED');
});

test('the used twin is still refused on its own row evidence', async () => {
  // Even where a free sibling exists, THIS row carrying a dateused is conclusive.
  const err = await refusal(() => assertCodeNotAlreadyConsumed(
    evidenceConn({ registered: 1, physicalRows: 2, uid: 4242 }),
    'PDDUPE7X9K2M',
    { id: 99998, code: 'PDDUPE7X9K2M', codestatus: 1, dateused: '2025-07-22 15:02:18' }
  ));
  assert.ok(err);
  assert.equal(err.details.evidence, 'used');
});

test('zero members and zero rows never refuses', async () => {
  // Guards the `membersRegistered > 0` term: without it 0 >= 0 would refuse a good code.
  await assertCodeNotAlreadyConsumed(
    evidenceConn({ registered: 0, physicalRows: 0 }), 'PDFRESH00001', { dateused: null }
  );
});

// --- the guard must be called with the CODE STRING, not the row id ---------

test('registration passes the activation CODE to the guard, never the row id', async () => {
  // Falsification pass, September 2026: swapping the argument to codeData.id left all
  // tests green while silently defeating the member-side check for every registration,
  // because the mocks answered any usertab query regardless of its parameters.
  const seen = [];
  const conn = {
    query: async (sql, params) => {
      seen.push({ sql, params });
      if (/FROM codestab WHERE code/i.test(sql)) {
        return [[{ id: 4242, code: 'PDPARAMCHK01', producttype: 10, codetype: 1,
                   productamount: 2500, codestatus: 1, dateused: null }]];
      }
      if (/membersRegistered/i.test(sql)) {
        return [[{ membersRegistered: 0, physicalRows: 1, registeredUid: null }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  await consumeActivationCodeForRegistration(conn, { activationCode: 'PDPARAMCHK01' });

  const evidenceCall = seen.find((c) => /membersRegistered/i.test(c.sql));
  assert.ok(evidenceCall, 'the guard must actually query for member-side evidence');
  assert.deepEqual(evidenceCall.params, ['PDPARAMCHK01', 'PDPARAMCHK01', 'PDPARAMCHK01'],
    'the guard must receive the code STRING; a row id can never match usertab.activationcode');
});

// --- route wiring: every consuming UPDATE is preceded by the guard ---------

test('all three code-consuming UPDATEs are guarded, and the guard runs first', () => {
  // routes/codes.js has no unit harness, so this asserts on the source the route
  // actually ships. It catches both deletion of a guard and reordering it after the
  // UPDATE, which would consume the code before refusing it.
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  const routes = read('routes/codes.js');
  const consuming = [...routes.matchAll(/UPDATE codestab SET dateused = NOW\(\), codestatus = 2/g)]
    .map((m) => m.index);
  assert.equal(consuming.length, 2, 'upgrade and maintenance each consume a code');

  const guards = [...routes.matchAll(/assertCodeNotAlreadyConsumed\(conn, code, codeData\)/g)]
    .map((m) => m.index);
  assert.equal(guards.length, 2, 'both consuming routes must call the guard');

  for (const [i, updateAt] of consuming.entries()) {
    assert.ok(guards[i] < updateAt,
      `guard ${i} must appear before the consuming UPDATE it protects`);
  }

  const service = read('services/registration.js');
  const regGuard = service.indexOf('assertCodeNotAlreadyConsumed(conn, activationCode, codeData)');
  const regUpdate = service.indexOf('SET dateused = NOW(), codestatus = 2');
  assert.ok(regGuard > -1, 'registration must call the guard with the code STRING');
  assert.ok(regGuard < regUpdate, 'registration guard must run before the consuming UPDATE');
});

test('the read-only code checks cannot advertise a consumed code', () => {
  // Otherwise an encoder gets a green light from preview and a refusal at submit.
  const fs = require('node:fs');
  const path = require('node:path');
  const service = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services/registration.js'), 'utf8');

  // Asserted per statement, not as a total count: a doc comment also names the clause,
  // and counting occurrences would pass on a comment while a query lost its filter.
  const statements = [
    /FROM codestab WHERE code = \? AND producttype >= 1[\s\S]*?dateused IS NULL/,
    /SELECT \* FROM codestab WHERE code = \? AND codestatus = '1' AND dateused IS NULL/,
    /FROM codestab[\s\S]{0,200}?WHERE uid = \?[\s\S]*?AND dateused IS NULL/,
  ];
  for (const [i, re] of statements.entries()) {
    assert.match(service, re, `read-only code query ${i} must exclude consumed codes`);
  }
});
