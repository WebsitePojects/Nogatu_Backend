const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveRegistrationCdState,
} = require('../../services/registration');

test('CD registration starts with unpaid CD balance', () => {
  assert.deepEqual(
    deriveRegistrationCdState({ codetype: 3, productamount: 25000 }),
    { cdAmount: 25000, cdTotal: 0, cdStatus: 1 }
  );
});

test('non-CD registration starts without CD obligation', () => {
  assert.deepEqual(
    deriveRegistrationCdState({ codetype: 1, productamount: 25000 }),
    { cdAmount: 0, cdTotal: 0, cdStatus: 0 }
  );

  assert.deepEqual(
    deriveRegistrationCdState({ codetype: 2, productamount: 25000 }),
    { cdAmount: 0, cdTotal: 0, cdStatus: 0 }
  );
});
