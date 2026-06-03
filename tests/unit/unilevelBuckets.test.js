const test = require('node:test');
const assert = require('node:assert/strict');

const { addUnilevelPointsToLevelBucket } = require('../../services/income/unilevel');

function emptyTotals() {
  return { lev1: 0, lev23: 0, lev45: 0, lev610: 0 };
}

test('unilevel level 1 points only count in level 1 bucket', () => {
  const totals = emptyTotals();
  addUnilevelPointsToLevelBucket(totals, 1, 200);
  assert.deepEqual(totals, { lev1: 200, lev23: 0, lev45: 0, lev610: 0 });
});

test('unilevel levels 2 and 3 only count in the 2-3 bucket', () => {
  const totals = emptyTotals();
  addUnilevelPointsToLevelBucket(totals, 2, 150);
  addUnilevelPointsToLevelBucket(totals, 3, 50);
  assert.deepEqual(totals, { lev1: 0, lev23: 200, lev45: 0, lev610: 0 });
});

test('unilevel levels 4 and 5 only count in the 4-5 bucket', () => {
  const totals = emptyTotals();
  addUnilevelPointsToLevelBucket(totals, 4, 120);
  addUnilevelPointsToLevelBucket(totals, 5, 80);
  assert.deepEqual(totals, { lev1: 0, lev23: 0, lev45: 200, lev610: 0 });
});

test('unilevel levels 6 to 10 only count in the 6-10 bucket', () => {
  const totals = emptyTotals();
  addUnilevelPointsToLevelBucket(totals, 6, 90);
  addUnilevelPointsToLevelBucket(totals, 10, 10);
  assert.deepEqual(totals, { lev1: 0, lev23: 0, lev45: 0, lev610: 100 });
});
