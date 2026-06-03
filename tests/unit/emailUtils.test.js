const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmail,
  isValidEmail,
} = require('../../utils/email');

test('normalizeEmail trims and lowercases member email addresses', () => {
  assert.equal(normalizeEmail('  Member@Example.COM  '), 'member@example.com');
});

test('isValidEmail accepts standard email addresses and rejects malformed values', () => {
  assert.equal(isValidEmail('member@example.com'), true);
  assert.equal(isValidEmail('member.example.com'), false);
  assert.equal(isValidEmail(''), false);
});
