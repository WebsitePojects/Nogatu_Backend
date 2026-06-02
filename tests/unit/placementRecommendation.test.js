const test = require('node:test');
const assert = require('node:assert/strict');

const {
  choosePlacementPreference,
  findExtremeOpenSlot,
  recommendPlacementForSponsor,
} = require('../../services/placementRecommendation');

function makePlacementConn({ childrenByUid = {}, statsByUid = {} }) {
  return {
    async query(sql, params = []) {
      if (String(sql).includes('FROM usertab WHERE refid = ?')) {
        return [childrenByUid[Number(params[0])] || []];
      }

      if (String(sql).includes('FROM binary_tree_closuretab')) {
        const stats = statsByUid[Number(params[0])] || {};
        return [[{
          member_count: Number(stats.memberCount || 0),
          point_total: Number(stats.pointTotal || 0),
        }]];
      }

      throw new Error(`Unexpected placement query: ${sql}`);
    },
  };
}

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

test('findExtremeOpenSlot walks only the requested extreme side', async () => {
  const conn = makePlacementConn({
    childrenByUid: {
      3: [{ uid: 5, position: 1, id: 50 }, { uid: 6, position: 2, id: 60 }],
      6: [{ uid: 7, position: 2, id: 70 }],
      7: [],
    },
  });

  const slot = await findExtremeOpenSlot(3, 2, conn);

  assert.deepEqual(slot, { placementUid: 7, position: 2 });
});

test('recommendPlacementForSponsor keeps auto spillover inside the root branch side', async () => {
  const conn = makePlacementConn({
    childrenByUid: {
      1: [{ uid: 2, position: 1, id: 20 }, { uid: 3, position: 2, id: 30 }],
      2: [{ uid: 4, position: 1, id: 40 }],
      3: [{ uid: 5, position: 1, id: 50 }],
    },
    statsByUid: {
      2: { memberCount: 2, pointTotal: 1000 },
      3: { memberCount: 1, pointTotal: 250 },
    },
  });

  const placement = await recommendPlacementForSponsor(1, conn);

  assert.equal(placement.placementUid, 3);
  assert.equal(placement.position, 2);
  assert.equal(placement.strategy, 'extreme-right');
});

test('recommendPlacementForSponsor forced first direct spills down the forced side if occupied', async () => {
  const conn = makePlacementConn({
    childrenByUid: {
      2: [{ uid: 4, position: 1, id: 40 }],
      4: [{ uid: 8, position: 1, id: 80 }],
      8: [],
    },
    statsByUid: {
      4: { memberCount: 2, pointTotal: 500 },
    },
  });

  const placement = await recommendPlacementForSponsor(2, conn, { forcedSide: 1 });

  assert.equal(placement.placementUid, 8);
  assert.equal(placement.position, 1);
  assert.equal(placement.strategy, 'forced-extreme-left');
});
