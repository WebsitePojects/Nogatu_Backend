const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeQualifiedDirectLegs } = require('../../services/binaryEligibility');

test('pairing unlocks when the owner has one personally sponsored qualified direct on either leg', () => {
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

  assert.equal(summary.canEarnPairing, true);
  assert.equal(summary.leftQualifiedCount, 0);
  assert.equal(summary.rightQualifiedCount, 1);
  assert.deepEqual(summary.missingLegs, ['left']);
  assert.equal(summary.qualifyingDirects.left.length, 0);
  assert.deepEqual(summary.qualifyingDirects.right.map((row) => row.username), ['TestCarl']);
  assert.equal(summary.reason, null);
});

test('pairing stays locked until the owner has the first personally sponsored qualified direct', () => {
  const summary = summarizeQualifiedDirectLegs(1096471, [
    {
      uid: 5001,
      drefid: 7777,
      ownerLeg: 'left',
      username: 'LeftSpillover',
      codeid: 1,
    },
    {
      uid: 5002,
      drefid: 8888,
      ownerLeg: 'right',
      username: 'RightSpillover',
      codeid: 1,
    },
  ]);

  assert.equal(summary.canEarnPairing, false);
  assert.equal(summary.leftQualifiedCount, 0);
  assert.equal(summary.rightQualifiedCount, 0);
  assert.deepEqual(summary.missingLegs.sort(), ['left', 'right']);
  assert.match(summary.reason || '', /personally recruit your first qualified direct on either leg/i);
});
