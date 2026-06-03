const test = require('node:test');
const assert = require('node:assert/strict');

const { getVoucherRepurchasePoints } = require('../../services/voucher');

test('voucher-funded purchases always credit zero repurchase points', () => {
  assert.equal(getVoucherRepurchasePoints(), 0);
});

