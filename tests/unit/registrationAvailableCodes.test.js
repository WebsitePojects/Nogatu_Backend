const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatAvailableCodeRow,
} = require('../../services/registration');

test('available registration codes keep legacy labels while exposing dropdown-rich fields', () => {
  const row = formatAvailableCodeRow({
    id: 22245,
    code: 'PDSIISWAOQYQ',
    producttype: 20,
    productamount: 5000,
    codetype: 1,
  });

  assert.equal(row.code, 'PDSIISWAOQYQ');
  assert.equal(row.accountLabel, 'Silver - PD');
  assert.equal(row.dropdownLabel, 'PD - Silver');
  assert.equal(row.packageLabel, 'Silver');
  assert.equal(row.codeTypeLabel, 'PD');
  assert.equal(row.packageAmount, 5000);
  assert.equal(row.displayName, 'PD - Silver - PDSIISWAOQYQ');
  assert.equal(row.legacyLabel, 'PD - Silver');
});
