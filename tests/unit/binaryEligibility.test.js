const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeQualifiedDirectLegs,
} = require('../../services/binaryEligibility');

test('qualified direct-leg gate ignores spillover placements from another sponsor', () => {
  const summary = summarizeQualifiedDirectLegs(7397233, [
    {
      uid: 1407558,
      drefid: 1096471,
      ownerLeg: 'left',
      username: 'TestMarkBy00001',
      codeid: 1,
    },
    {
      uid: 5756457,
      drefid: 7397233,
      ownerLeg: 'right',
      username: 'TestCarl',
      codeid: 1,
    },
  ]);

  assert.equal(summary.canEarnPairing, false);
  assert.equal(summary.leftQualifiedCount, 0);
  assert.equal(summary.rightQualifiedCount, 1);
  assert.equal(summary.qualifyingDirects.left.length, 0);
  assert.deepEqual(summary.qualifyingDirects.right.map((row) => row.username), ['TestCarl']);
});

test('qualified direct-leg gate counts the owner direct inside either subtree leg', () => {
  const summary = summarizeQualifiedDirectLegs(1096471, [
    {
      uid: 5001,
      drefid: 1096471,
      ownerLeg: 'left',
      username: 'LeftDirect',
      codeid: 1,
    },
    {
      uid: 5002,
      drefid: 1096471,
      ownerLeg: 'right',
      username: 'RightDirect',
      codeid: 3,
      cdamount: 2500,
      cdtotal: 2500,
      cdstatus: 2,
    },
  ]);

  assert.equal(summary.canEarnPairing, true);
  assert.equal(summary.leftQualifiedCount, 1);
  assert.equal(summary.rightQualifiedCount, 1);
});
