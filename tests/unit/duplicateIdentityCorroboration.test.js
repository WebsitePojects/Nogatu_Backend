/**
 * Duplicate-identity policy: a shared name needs a corroborating identifier.
 *
 * Incident 2026-08-27. A paid Gold registration for Ruben Abayan Ramos was refused
 * because an unrelated Ruben Dinglasan Ramos (Rambo001, uid 2516680) already existed.
 * That record carries no dob, no email, no contact number and no TIN, so nothing
 * about the two men matched except the first and last name.
 *
 * Production already holds 118 first+last name groups covering 240 members, every one
 * registered legitimately, so the old rule would have rejected 122 existing members.
 *
 * The rule now blocks on a TIN match alone, or on a name match ONLY when a second
 * independent identifier agrees: dob, email, or contact number.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDuplicateIdentity } = require('../../services/identityIntegrity');

const connReturning = (...rows) => ({ query: async () => [rows] });

// --- the incident itself ---------------------------------------------------

test('the Ruben Ramos incident: same name, existing record has no identifiers at all', async () => {
  const result = await evaluateDuplicateIdentity({
    firstname: 'Ruben',
    lastname: 'Ramos',
    middlename: 'Abayan',
    tin: '',
    email: 'rbn_rms@yahoo.com',
    contactno: '09175704217',
    dob: '1950-12-04',
    address: '23F Venus St Tandang Sora Quezon City',
  }, connReturning({
    uid: 2516680,
    firstname: 'Ruben',
    lastname: 'Ramos',
    middlename: 'Dinglasan',
    tin: null,
    email: null,
    contactnos: null,
    dob: null,
    address: null,
  }));

  assert.equal(result.allowed, true, 'nothing corroborates the name, so it must not block');
  assert.equal(result.matchedUid, null);
});

test('two EMPTY fields must never count as agreeing with each other', async () => {
  // Otherwise every legacy record with blank details would block every later
  // applicant who happens to share its name - the incident, generalised.
  const result = await evaluateDuplicateIdentity({
    firstname: 'Juan',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactno: '',
    dob: '',
    address: '',
  }, connReturning({
    uid: 4001,
    firstname: 'Juan',
    lastname: 'Cruz',
    middlename: '',
    tin: '',
    email: '',
    contactnos: '',
    dob: '',
    address: '',
  }));

  assert.equal(result.allowed, true);
});

// --- a corroborated name match must still block ----------------------------

const corroborators = [
  { label: 'birthday', column: 'dob', inputKey: 'dob', value: '1990-01-01', signal: 'dob' },
  { label: 'contact number', column: 'contactnos', inputKey: 'contactno', value: '09170000000', signal: 'contactno' },
  { label: 'email', column: 'email', inputKey: 'email', value: 'same@example.com', signal: 'email' },
];

for (const probe of corroborators) {
  test('same name PLUS the same ' + probe.label + ' still blocks', async () => {
    const row = {
      uid: 5005,
      firstname: 'Maria',
      lastname: 'Santos',
      middlename: '',
      tin: '',
      email: 'other@example.com',
      contactnos: '09990000000',
      dob: '1975-05-05',
      address: 'Old address',
    };
    row[probe.column] = probe.value;

    const input = {
      firstname: 'Maria',
      lastname: 'Santos',
      middlename: 'X',
      tin: '',
      email: 'new@example.com',
      contactno: '09881111111',
      dob: '1988-08-08',
      address: 'New address',
    };
    input[probe.inputKey] = probe.value;

    const result = await evaluateDuplicateIdentity(input, connReturning(row));

    assert.equal(result.allowed, false, 'a corroborated name match must still block');
    assert.equal(result.matchedUid, 5005);
    assert.ok(result.matchedSignals.includes('firstname_lastname'));
    assert.ok(result.matchedSignals.includes(probe.signal),
      'the corroborating signal must be reported for the audit log');
    assert.equal(result.reason, 'firstname-lastname-with-corroborating-signal-match');
  });
}

test('a corroborating identifier WITHOUT a name match does not block', async () => {
  // Only the name gate was loosened. Sharing a birthday with a stranger must not
  // start blocking people who were previously allowed through.
  const result = await evaluateDuplicateIdentity({
    firstname: 'Ana',
    lastname: 'Lopez',
    middlename: '',
    tin: '',
    email: 'ana@example.com',
    contactno: '09170000000',
    dob: '1990-01-01',
    address: 'Somewhere',
  }, connReturning({
    uid: 8008,
    firstname: 'Beatriz',
    lastname: 'Tan',
    middlename: '',
    tin: '',
    email: 'other@example.com',
    contactnos: '09170000000',
    dob: '1990-01-01',
    address: 'Elsewhere',
  }));

  assert.equal(result.allowed, true);
});

// --- deliberate exclusions and preserved behaviour -------------------------

test('a shared ADDRESS is deliberately NOT corroborating - relatives share a household', async () => {
  const result = await evaluateDuplicateIdentity({
    firstname: 'Pedro',
    lastname: 'Reyes',
    middlename: 'B',
    tin: '',
    email: 'apo@example.com',
    contactno: '09991111111',
    dob: '1995-06-06',
    address: '12 Mabini St, Quezon City',
  }, connReturning({
    uid: 6006,
    firstname: 'Pedro',
    lastname: 'Reyes',
    middlename: 'A',
    tin: '',
    email: 'lolo@example.com',
    contactnos: '09170000000',
    dob: '1940-01-01',
    address: '12 Mabini St, Quezon City',
  }));

  assert.equal(result.allowed, true);
});

test('a TIN match still blocks on its own, with no name match', async () => {
  // normalizeTinValue strips whitespace only, not punctuation, so both sides must
  // carry the same format. Registration normalizes via utils/tin before it gets
  // here; this fix does not change TIN comparison in any way.
  const result = await evaluateDuplicateIdentity({
    firstname: 'Someone',
    lastname: 'Else',
    middlename: '',
    tin: '123-456-789',
    email: 'x@example.com',
    contactno: '09170000001',
    dob: '2000-01-01',
    address: 'Somewhere',
  }, connReturning({
    uid: 7007,
    firstname: 'Completely',
    lastname: 'Different',
    middlename: '',
    tin: '123-456-789',
    email: null,
    contactnos: null,
    dob: null,
    address: null,
  }));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'tin-match');
  assert.deepEqual(result.matchedSignals, ['tin']);
});

test('an all-zero TIN is still ignored on both sides', async () => {
  const result = await evaluateDuplicateIdentity({
    firstname: 'Jose',
    lastname: 'Rizal',
    middlename: '',
    tin: '000-000-000-000',
    email: 'jose@example.com',
    contactno: '09170000003',
    dob: '1861-06-19',
    address: 'Calamba',
  }, connReturning({
    uid: 9009,
    firstname: 'Andres',
    lastname: 'Bonifacio',
    middlename: '',
    tin: '000-000-000-000',
    email: null,
    contactnos: null,
    dob: null,
    address: null,
  }));

  assert.equal(result.allowed, true, 'a placeholder TIN must not link two strangers');
});

test('a blocking row later in the result set is still found', async () => {
  // The loop must not stop at the first candidate that fails to block.
  const result = await evaluateDuplicateIdentity({
    firstname: 'Ana',
    lastname: 'Lim',
    middlename: '',
    tin: '',
    email: 'ana@example.com',
    contactno: '09170000002',
    dob: '1992-02-02',
    address: 'Anywhere',
  }, connReturning(
    { uid: 1, firstname: 'Ana', lastname: 'Lim', middlename: '', tin: '', email: null, contactnos: null, dob: null, address: null },
    { uid: 2, firstname: 'Ana', lastname: 'Lim', middlename: '', tin: '', email: null, contactnos: null, dob: '1992-02-02', address: null },
  ));

  assert.equal(result.allowed, false);
  assert.equal(result.matchedUid, 2, 'must keep scanning past the non-blocking row');
});
