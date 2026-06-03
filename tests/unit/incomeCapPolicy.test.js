const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLifetimeIncomeCeiling,
  getLifetimeIncomeHeadroom,
} = require('../../services/income/incomeCapPolicy');

test('applyLifetimeIncomeCeiling blocks all further income once a bronze account reaches its lifetime cap', () => {
  const adjusted = applyLifetimeIncomeCeiling({
    packagePolicy: { packageLabel: 'Bronze', lifetimeIncomeCeiling: 40000 },
    storedTotals: {
      ttlincome1: 10000,
      ttlincome2: 10000,
      ttlincome3: 5000,
      ttlincome4: 5000,
      ttlincome5: 5000,
      ttlincome6: 5000,
    },
    proposedIncome: {
      dref: 500,
      paircash: 1000,
      leadership: 200,
      unilevel: 100,
      hifive: 300,
    },
  });

  assert.equal(getLifetimeIncomeHeadroom({ packagePolicy: { lifetimeIncomeCeiling: 40000 }, storedTotals: adjusted.baseStoredTotals }), 0);
  assert.deepEqual(adjusted.allowedIncome, {
    dref: 0,
    paircash: 0,
    leadership: 0,
    unilevel: 0,
    hifive: 0,
  });
  assert.equal(adjusted.blockedTotal, 2100);
});

test('applyLifetimeIncomeCeiling clips mixed income deterministically against remaining silver headroom', () => {
  const adjusted = applyLifetimeIncomeCeiling({
    packagePolicy: { packageLabel: 'Silver', lifetimeIncomeCeiling: 80000 },
    storedTotals: {
      ttlincome1: 15000,
      ttlincome2: 15000,
      ttlincome3: 10000,
      ttlincome4: 10000,
      ttlincome5: 10000,
      ttlincome6: 17000,
    },
    proposedIncome: {
      dref: 1000,
      paircash: 3000,
      leadership: 800,
      unilevel: 500,
      hifive: 700,
    },
  });

  assert.deepEqual(adjusted.allowedIncome, {
    dref: 1000,
    paircash: 2000,
    leadership: 0,
    unilevel: 0,
    hifive: 0,
  });
  assert.equal(adjusted.allowedTotal, 3000);
  assert.equal(adjusted.blockedTotal, 3000);
});
