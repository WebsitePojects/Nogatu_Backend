const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveGenealogyPoints } = require('../../services/network');

test('resolveGenealogyPoints prefers stored binary points when present', () => {
  assert.equal(resolveGenealogyPoints(40, 3000), 3000);
});

test('resolveGenealogyPoints falls back to package binary points when stored value is empty', () => {
  assert.equal(resolveGenealogyPoints(10, 0), 250);
  assert.equal(resolveGenealogyPoints(40, null), 2500);
  assert.equal(resolveGenealogyPoints(60, undefined), 15000);
});
