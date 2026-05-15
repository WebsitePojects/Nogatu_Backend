const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INCOME_PAYOUT_FLAGS,
} = require('../../services/income/calculateAndStoreIncome');

test('approved Node launch enables Unilevel payout while reserving income6 for ranking', () => {
  assert.equal(INCOME_PAYOUT_FLAGS.unilevel, true);
  assert.equal(INCOME_PAYOUT_FLAGS.lpc, false);
});
