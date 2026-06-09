const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPlacementPolicyForSponsor,
} = require('../../services/binaryPlacementPolicy');

test('root sponsor can manually choose placement before the first direct recruit', async () => {
  const conn = {
    query: async (sql) => {
      if (/FROM usertab\s+WHERE uid = \?/i.test(sql)) {
        return [[{ uid: 1001, refid: 0, drefid: 0, position: null }]];
      }
      if (/COUNT\(\*\) AS total_direct/i.test(sql)) {
        return [[{ total_direct: 0 }]];
      }
      return [[]];
    },
  };

  const policy = await getPlacementPolicyForSponsor(1001, conn);
  assert.equal(policy.mode, 'manual');
  assert.equal(policy.forcedPosition, null);
  assert.equal(policy.reason, 'manual-placement-allowed');
});

test('sponsor on left can still manually choose placement before the first direct recruit', async () => {
  const conn = {
    query: async (sql) => {
      if (/FROM usertab\s+WHERE uid = \?/i.test(sql)) {
        return [[{ uid: 2002, refid: 1001, drefid: 1001, position: 1 }]];
      }
      if (/COUNT\(\*\) AS total_direct/i.test(sql)) {
        return [[{ total_direct: 0 }]];
      }
      return [[]];
    },
  };

  const policy = await getPlacementPolicyForSponsor(2002, conn);
  assert.equal(policy.mode, 'manual');
  assert.equal(policy.forcedPosition, null);
  assert.equal(policy.reason, 'manual-placement-allowed');
});

test('sponsor on right can still manually choose placement before the first direct recruit', async () => {
  const conn = {
    query: async (sql) => {
      if (/FROM usertab\s+WHERE uid = \?/i.test(sql)) {
        return [[{ uid: 3003, refid: 1001, drefid: 1001, position: 2 }]];
      }
      if (/COUNT\(\*\) AS total_direct/i.test(sql)) {
        return [[{ total_direct: 0 }]];
      }
      return [[]];
    },
  };

  const policy = await getPlacementPolicyForSponsor(3003, conn);
  assert.equal(policy.mode, 'manual');
  assert.equal(policy.forcedPosition, null);
  assert.equal(policy.reason, 'manual-placement-allowed');
});

test('sponsor with an existing direct recruit returns to manual placement', async () => {
  const conn = {
    query: async (sql) => {
      if (/FROM usertab\s+WHERE uid = \?/i.test(sql)) {
        return [[{ uid: 4004, refid: 1001, drefid: 1001, position: 1 }]];
      }
      if (/COUNT\(\*\) AS total_direct/i.test(sql)) {
        return [[{ total_direct: 1 }]];
      }
      return [[]];
    },
  };

  const policy = await getPlacementPolicyForSponsor(4004, conn);
  assert.equal(policy.mode, 'manual');
  assert.equal(policy.forcedPosition, null);
  assert.equal(policy.reason, 'manual-placement-allowed');
});
