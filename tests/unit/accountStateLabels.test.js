const test = require('node:test');
const assert = require('node:assert/strict');

const { getAccountStateLabel } = require('../../services/accountState');

test('account state labels distinguish PD, FS, CD, and CD paid states', () => {
  assert.equal(getAccountStateLabel({ codeid: 1, cdstatus: 0 }), 'PD');
  assert.equal(getAccountStateLabel({ codeid: 2, cdstatus: 0 }), 'FS');
  assert.equal(getAccountStateLabel({ codeid: 3, cdstatus: 1 }), 'CD');
  assert.equal(getAccountStateLabel({ codeid: 3, cdstatus: 2 }), 'CD - Paid');
});
