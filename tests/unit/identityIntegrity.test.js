const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateDuplicateIdentity,
  normalizeIdentityName,
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

test('same normalized name alone does not block', async () => {
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
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Bautista',
    lastname: 'Vergel',
    middlename: '',
    tin: '222-222-222',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1991-02-02',
  }, conn);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.matchedSignals, []);
});

test('same normalized name plus matching tin blocks registration', async () => {
  const conn = {
    query: async () => [[{
      uid: 2002,
      firstname: 'Vergel',
      lastname: 'Bautista',
      middlename: '',
      tin: '123-456-789',
      email: 'old@example.com',
      contactnos: '09170000000',
      dob: '1990-01-01',
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Bautista',
    lastname: 'Vergel',
    middlename: '',
    tin: '123-456-789',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1991-02-02',
  }, conn);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.matchedSignals, ['tin']);
  assert.equal(result.matchedUid, 2002);
});

test('same normalized name plus matching dob blocks registration', async () => {
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
    }]],
  };

  const result = await evaluateDuplicateIdentity({
    firstname: 'Vergel',
    lastname: 'Bautista',
    middlename: '',
    tin: '222-222-222',
    email: 'new@example.com',
    contactno: '09990000000',
    dob: '1990-01-01',
  }, conn);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.matchedSignals, ['dob']);
});
