const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PACKAGE_BINARY_POINTS,
  PACKAGE_BINARY_VALUES,
  PRODUCT_TYPES,
} = require('../../utils/helpers');

test('package binary helpers separate BP counts from peso values', () => {
  assert.equal(PACKAGE_BINARY_POINTS[10], 1);
  assert.equal(PACKAGE_BINARY_POINTS[40], 10);
  assert.equal(PACKAGE_BINARY_POINTS[60], 60);

  assert.equal(PACKAGE_BINARY_VALUES[10], 250);
  assert.equal(PACKAGE_BINARY_VALUES[40], 2500);
  assert.equal(PACKAGE_BINARY_VALUES[60], 15000);
});

test('product type labels cover the expanded landing-page maintenance catalog', () => {
  assert.equal(PRODUCT_TYPES[100], 'Nogatu Barley Juice');
  assert.equal(PRODUCT_TYPES[106], 'Vitamin C with Zinc & Mangosteen');
  assert.equal(PRODUCT_TYPES[107], 'Nogatu Max Fuel Coffee Drink Mix');
  assert.equal(PRODUCT_TYPES[109], 'Berry NAD+');
});
