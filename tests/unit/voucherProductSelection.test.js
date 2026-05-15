const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeVoucherProductSelection } = require('../../services/voucher');

test('voucher product selection resolves by product key', () => {
  const product = normalizeVoucherProductSelection({ productKey: 'bl' });

  assert.equal(product.code, 100);
  assert.equal(product.incentivePoints, 50);
});

test('voucher product selection resolves by product code', () => {
  const product = normalizeVoucherProductSelection({ productCode: 104 });

  assert.equal(product.name, 'Chocolate Drink Mix');
  assert.equal(product.incentivePoints, 45);
});

test('voucher product selection rejects unknown products', () => {
  assert.equal(normalizeVoucherProductSelection({ productKey: 'unknown' }), null);
  assert.equal(normalizeVoucherProductSelection({ productCode: 999 }), null);
});
