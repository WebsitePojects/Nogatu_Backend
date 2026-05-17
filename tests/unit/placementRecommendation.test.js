const test = require('node:test');
const assert = require('node:assert/strict');

const {
  choosePlacementPreference,
} = require('../../services/placementRecommendation');

test('choosePlacementPreference prefers an open direct left slot first', () => {
  const side = choosePlacementPreference({
    leftOpen: true,
    rightOpen: false,
    leftPoints: 5000,
    rightPoints: 1000,
    leftCount: 20,
    rightCount: 4,
  });

  assert.equal(side, 1);
});

test('choosePlacementPreference chooses the weaker leg by repurchase-driving subtree strength', () => {
  const side = choosePlacementPreference({
    leftOpen: false,
    rightOpen: false,
    leftPoints: 12500,
    rightPoints: 5000,
    leftCount: 16,
    rightCount: 8,
  });

  assert.equal(side, 2);
});

test('choosePlacementPreference breaks point ties using member count', () => {
  const side = choosePlacementPreference({
    leftOpen: false,
    rightOpen: false,
    leftPoints: 7500,
    rightPoints: 7500,
    leftCount: 14,
    rightCount: 6,
  });

  assert.equal(side, 2);
});
