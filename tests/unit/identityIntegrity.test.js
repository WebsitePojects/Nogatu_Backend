const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateDuplicateIdentity,
  normalizeIdentityName,
  isCloseNameMatch,
} = require('../../services/identityIntegrity');

test('normalizeIdentityName preserves suffix distinctions', () => {
  const withoutSuffix = normalizeIdentityName({
    firstname: 'Vergel',
    lastname: 'Bautista',
    middlename: 'T',
  });
  const withSuffix = normalizeIdentityName({
    firstname: 'Vergel',
    lastname: 'Bautista Jr.',
    middlename: 'T',
  });

  assert.notEqual(withoutSuffix.suffix, withSuffix.suffix);
  assert.notEqual(withoutSuffix.fingerprint, withSuffix.fingerprint);
});

test('same address, contact, and email signals do not block alone when name+tin+dob all differ', async () => {
  const conn = {
    query: async () => [[{
      uid: 2002,
      username: 'oldacct01',
      firstname: 'Vergel',
      lastname: 'Bautista',
      middlename: '',
      tin: '111-111-111',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1990-01-01',
      address: '123 Sampaguita St., Manila',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Marissa',
    lastname: 'Villanueva',
    middlename: '',
    tin: '222-222-222',
    email: 'old@example.com',
    contactno: '09170000000',
    dob: '1985-05-05',
    address: '123 Sampaguita St., Manila',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
  assert.equal(result.matchedUid, null);
  assert.equal(result.rule, null);
});

test('FALSIFICATION FINDING (behavior change vs pre-R4): "Vergel Bautista" vs "Vergel Bautista-Santos" WITH the same dob now correctly blocks under R4', async () => {
  // This exact fixture pre-dates R4 and used to be allowed (there was no
  // fuzzy+dob rule yet). Verified directly against the existing, UNMODIFIED
  // isCloseNameMatch()/jaroWinklerSimilarity() helpers: comparable strings
  // "vergel bautista santos" vs "vergel bautista" score ~0.936 (>= 0.92)
  // because one name is a prefix of the other -- Jaro-Winkler inherently
  // inflates prefix-containment pairs (all of the shorter string's
  // characters trivially match, and the shared-prefix bonus adds more on
  // top). Combined with an EXACT same dob, this now legitimately satisfies
  // R4 exactly as management specified it (isCloseNameMatch true AND same
  // dob). This is arguably the INTENDED catch -- appending a second surname
  // while keeping the same birthdate is a classic duplicate-registration
  // evasion pattern -- but it is a real, business-visible behavior change
  // from before R4 existed, and the same prefix-containment effect could
  // also trip on two DIFFERENT people whose names happen to nest this way
  // AND who coincidentally share an exact birthdate. Flagged here
  // deliberately rather than silently patched (no threshold/exception was
  // requested, and weakening the shared helper was explicitly out of scope).
  const conn = {
    query: async () => [[{
      uid: 2003,
      username: 'oldacct02',
      firstname: 'Vergel',
      lastname: 'Bautista',
      middlename: '',
      tin: '111-111-111',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1990-01-01',
      address: '123 Sampaguita St., Manila',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Vergel',
    lastname: 'Bautista-Santos',
    middlename: '',
    tin: '222-222-222',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1990-01-01', // same dob as the existing row
    address: 'A different address entirely',
  }, conn);

  assert.equal(result.allowed, false);
  assert.equal(result.rule, 'name_similar_dob');
});

test('same first name and last name blocks registration even when other details differ (R2 exact, regression)', async () => {
  const conn = {
    query: async () => [[{
      uid: 2002,
      username: 'vbautista',
      firstname: 'Vergel',
      lastname: 'Bautista',
      middlename: '',
      tin: '111-111-111',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1990-01-01',
      address: 'Old address',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Vergel',
    lastname: 'Bautista',
    middlename: 'T',
    tin: '',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1991-02-02',
    address: 'New address',
  }, conn);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.matchedSignals, ['name_exact']);
  assert.equal(result.rule, 'name_exact');
  assert.equal(result.matchedUid, 2002);
  assert.equal(result.matchedUsername, 'vbautista');
  assert.equal(result.matchedName, 'Vergel Bautista');
});

test('same tin blocks registration even when first and last name differ (R1, regression)', async () => {
  const conn = {
    query: async () => [[{
      uid: 3333,
      username: 'creyes',
      firstname: 'Cristina',
      lastname: 'Reyes',
      middlename: '',
      tin: '123-456-789',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1992-11-12',
      address: 'Manila',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Kristina',
    lastname: 'Ramos',
    middlename: '',
    tin: '123-456-789',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1999-10-10',
    address: 'Quezon City',
  }, conn);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.matchedSignals, ['tin']);
  assert.equal(result.rule, 'tin');
  assert.equal(result.matchedUid, 3333);
});

test('same tin and same first+last returns both matched signals, strongest rule is tin (regression)', async () => {
  const conn = {
    query: async () => [[{
      uid: 4444,
      username: 'jpolo',
      firstname: 'John',
      lastname: 'Polo',
      middlename: '',
      tin: '999-999-999',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1992-11-12',
      address: 'Manila',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'John',
    lastname: 'Polo',
    middlename: 'T',
    tin: '999-999-999',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1999-10-10',
    address: 'Quezon City',
  }, conn);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.matchedSignals, ['tin', 'name_exact']);
  assert.equal(result.rule, 'tin');
  assert.equal(result.matchedUid, 4444);
});

test('suffix distinction is not treated as close-name duplicate', async () => {
  const withSuffix = normalizeIdentityName({
    firstname: 'Vergel',
    lastname: 'Bautista Jr.',
    middlename: '',
  });
  const noSuffix = normalizeIdentityName({
    firstname: 'Vergel',
    lastname: 'Bautista',
    middlename: '',
  });

  assert.equal(isCloseNameMatch(withSuffix, noSuffix), false);
});

// --- NEW: R3 switched name ---------------------------------------------

test('R3: switched name blocks registration (Ronnie C Porras vs Porras C. Ronnie real case)', async () => {
  const conn = {
    query: async () => [[{
      uid: 555111,
      username: 'porrasA1',
      firstname: 'Ronnie',
      lastname: 'Porras',
      middlename: 'C',
      tin: '',
      email: 'ronnie.old@example.com',
      contactnos: '09171234567',
      dob: '1988-01-25',
      address: 'Cavite',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Porras',
    lastname: 'Ronnie',
    middlename: 'C',
    tin: '',
    email: 'ronnie.new@example.com',
    contactno: '09179999999',
    dob: '1988-01-25',
    address: 'Different address',
  }, conn);

  assert.equal(result.allowed, false);
  assert.equal(result.rule, 'name_switched');
  assert.ok(result.matchedSignals.includes('name_switched'));
  assert.equal(result.matchedUid, 555111);
  assert.equal(result.matchedUsername, 'porrasA1');
});

test('R3: switched-name guard does not fire across a suffix boundary (Jr vs no-suffix, switched order)', async () => {
  const conn = {
    query: async () => [[{
      uid: 60001,
      username: 'cruzjohnjr',
      firstname: 'John',
      lastname: 'Cruz Jr',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '1970-05-05',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Cruz',
    lastname: 'John',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  // Without the suffix guard, bareFingerprint("cruz","john") would equal
  // bareFingerprint("john","cruz" [suffix stripped]) and falsely fire R3.
  assert.equal(result.allowed, true);
  assert.equal(result.rule, null);
});

// --- NEW: R4 similar name + same dob ------------------------------------

test('R4: similar name + same dob blocks registration', async () => {
  const conn = {
    query: async () => [[{
      uid: 70002,
      username: 'johncruz88',
      firstname: 'John',
      lastname: 'Cruz',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '1988-06-15',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Jhon',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '1988-06-15',
    address: '',
  }, conn);

  assert.equal(result.allowed, false);
  assert.equal(result.rule, 'name_similar_dob');
  assert.ok(result.matchedSignals.includes('name_similar'));
  assert.ok(result.matchedSignals.includes('dob'));
});

test('R4 guard: similar name + DIFFERENT dob ALLOWS (fuzzy similarity alone must never block)', async () => {
  const conn = {
    query: async () => [[{
      uid: 70003,
      username: 'johncruz99',
      firstname: 'John',
      lastname: 'Cruz',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '1975-03-03',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Jhon',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '1988-06-15',
    address: '',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
  assert.equal(result.rule, null);
});

test('R4 guard: similar name + both DOBs empty ALLOWS', async () => {
  const conn = {
    query: async () => [[{
      uid: 70004,
      username: 'johncruzNoDob',
      firstname: 'John',
      lastname: 'Cruz',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Jhon',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
  assert.equal(result.rule, null);
});

// --- NEW: shared contact number / genuinely different people ------------

test('different people sharing only a contact number ALLOWS (Rafael Amatril vs Rafael Castillo real case)', async () => {
  const conn = {
    query: async () => [[{
      uid: 80001,
      username: 'ramatril65',
      firstname: 'Rafael',
      lastname: 'Amatril',
      middlename: '',
      tin: '',
      email: 'amatril@example.com',
      contactnos: '09170001111',
      dob: '1965-10-24',
      address: 'Team address',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Rafael',
    lastname: 'Castillo',
    middlename: '',
    tin: '',
    email: 'castillo@example.com',
    contactno: '09170001111', // same shared team/family number
    dob: '1985-09-28',
    address: 'Team address',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
  assert.equal(result.rule, null);
  assert.equal(result.matchedUid, null);
});

// --- NEW: all-empty input performs NO query ------------------------------

test('all-empty input returns allowed:true and issues NO query', async () => {
  let queryCalled = false;
  const conn = {
    query: async () => {
      queryCalled = true;
      return [[]];
    },
  };

  const result = await evaluateDuplicateIdentity({
    firstname: '',
    lastname: '',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  assert.equal(result.allowed, true);
  assert.equal(result.matchedUid, null);
  assert.equal(result.matchedUsername, null);
  assert.equal(result.matchedName, null);
  assert.deepEqual(result.matchedSignals, []);
  assert.equal(result.rule, null);
  assert.equal(queryCalled, false, 'expected evaluateDuplicateIdentity to skip the DB entirely');
});

// --- NEW: narrowing query shape (locks in the completeness argument) ----

test('narrowing query skips empty arms and includes only usable ones', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const conn = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [[]];
    },
  };

  // Only firstname/lastname are usable; tin and dob are empty.
  await evaluateDuplicateIdentity({
    firstname: 'Ana',
    lastname: 'Reyes',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  assert.ok(!/tin = \?/.test(capturedSql), 'tin arm must be skipped when tin is empty');
  assert.ok(!/dob = \?/.test(capturedSql), 'dob arm must be skipped when dob is empty');
  assert.ok(/LOWER\(firstname\) IN/.test(capturedSql));
  assert.ok(/LOWER\(lastname\) IN/.test(capturedSql));
  assert.deepEqual(capturedParams, ['Ana', 'Reyes', 'Ana', 'Reyes']);
});

test('narrowing query skips the tin arm when tin is a zero-tin placeholder', async () => {
  let capturedSql = '';
  const conn = {
    query: async (sql) => {
      capturedSql = sql;
      return [[]];
    },
  };

  await evaluateDuplicateIdentity({
    firstname: 'Ana',
    lastname: 'Reyes',
    middlename: '',
    tin: '000-000-000-000',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  assert.ok(!/tin = \?/.test(capturedSql), 'tin arm must be skipped for a zero-tin placeholder');
});

// --- Falsification: unicode / accented names -----------------------------

test('FALSIFICATION FINDING: accented name variant (Jose vs Jose with accent) does not exact-match via R2', async () => {
  // KNOWN LIMITATION (pre-existing in cleanNamePart, not introduced here):
  // cleanNamePart() strips any non a-z0-9 byte, INCLUDING accented letters,
  // rather than folding them to their base ASCII letter. "José" -> "jos "
  // (the accented e becomes a space) while "Jose" -> "jose". These do not
  // produce the same normalized key, so R2 (and R3, which is built on the
  // same cleaned tokens) MISS this pair. This is inherited, documented
  // behavior of a helper this task was scoped to reuse, not rewrite -- it is
  // recorded here as an intentionally-not-fixed finding, not asserted as
  // correct duplicate detection.
  const conn = {
    query: async () => [[{
      uid: 90001,
      username: 'josecruz',
      firstname: 'José', // "José"
      lastname: 'Cruz',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Jose',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  // Documents the current (imperfect) behavior: this pair is NOT caught.
  assert.equal(result.allowed, true);
});

// --- Falsification: DOB format drift --------------------------------------

test('FALSIFICATION FINDING: same calendar date in two different string formats does not match via R4/dob', async () => {
  // KNOWN LIMITATION: normalizeDob() only lowercases/trims -- it does not
  // parse or canonicalize date formats. A legacy row stored as US-style
  // '01/25/1988' will NOT be recognized as the same date as an ISO
  // '1988-01-25' input, even though a human would call them identical.
  // Documented here deliberately rather than silently "fixed" by guessing a
  // date-parsing scheme (which risks misreading day-first vs month-first
  // legacy data) -- see money-integrity rule: report discrepancies, don't
  // guess-reconcile.
  const conn = {
    query: async () => [[{
      uid: 90002,
      username: 'legacyuser',
      firstname: 'Jhon', // deliberately close, not exact, to also probe R4
      lastname: 'Cruz',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: '01/25/1988',
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'John',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '1988-01-25',
    address: '',
  }, conn);

  // Documents the current (imperfect) behavior: dob strings differ byte-for-byte
  // so R4 does not fire even though the underlying calendar date is identical.
  assert.equal(result.allowed, true);
});

test('empty/NULL dob never matches another empty/NULL dob', async () => {
  const conn = {
    query: async () => [[{
      uid: 90003,
      username: 'nodob1',
      firstname: 'Maria',
      lastname: 'Santos',
      middlename: '',
      tin: '',
      email: '',
      contactnos: '',
      dob: null,
      address: '',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Maria', // exact same name too, to isolate the dob comparison itself
    lastname: 'Santos',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, conn);

  // name_exact still fires (R2), but 'dob' must NOT be in matchedSignals.
  assert.equal(result.allowed, false);
  assert.equal(result.rule, 'name_exact');
  assert.ok(!result.matchedSignals.includes('dob'), 'empty/NULL dob must never be reported as a dob match');
});
