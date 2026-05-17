const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveCdSettlementState,
} = require('../../services/cdAccountsPolicy');

test('deriveCdSettlementState counts fully paid only when deduction recovery reaches the CD amount', () => {
  const recovered = deriveCdSettlementState({
    codeid: 3,
    cdstatus: 2,
    cdamount: 25000,
    cdtotal: 25000,
    totalCdDeduction: 25000,
  });

  const settledOutsideRecovery = deriveCdSettlementState({
    codeid: 3,
    cdstatus: 2,
    cdamount: 25000,
    cdtotal: 25000,
    totalCdDeduction: 0,
  });

  assert.equal(recovered.isRecoveredFullyPaid, true);
  assert.equal(recovered.statusLabel, 'Fully Paid');
  assert.equal(settledOutsideRecovery.isRecoveredFullyPaid, false);
  assert.equal(settledOutsideRecovery.statusLabel, 'Settled Outside Deduction');
});
