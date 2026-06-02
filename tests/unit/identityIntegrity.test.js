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

test('same address, dob, contact, and similar username signals do not block when first+last and tin differ', async () => {
  const conn = {
    query: async () => [[{
      uid: 2002,
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
    email: 'old@example.com',
    contactno: '09170000000',
    dob: '1990-01-01',
    address: '123 Sampaguita St., Manila',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
});

test('same first name and last name blocks registration even when other details differ', async () => {
  const conn = {
    query: async () => [[{
      uid: 2002,
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
  assert.deepEqual(result.matchedSignals, ['firstname_lastname']);
  assert.equal(result.matchedUid, 2002);
});

test('same tin blocks registration even when first and last name differ', async () => {
  const conn = {
    query: async () => [[{
      uid: 3333,
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
  assert.equal(result.matchedUid, 3333);
});

test('same tin and same first+last returns both matched signals', async () => {
  const conn = {
    query: async () => [[{
      uid: 4444,
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
  assert.deepEqual(result.matchedSignals, ['tin', 'firstname_lastname']);
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
