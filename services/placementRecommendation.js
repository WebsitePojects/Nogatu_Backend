const { pool } = require('../config/database');

function toNumber(value) {
  return Number(value || 0);
}

function choosePlacementPreference({
  leftOpen = false,
  rightOpen = false,
  leftPoints = 0,
  rightPoints = 0,
  leftCount = 0,
  rightCount = 0,
} = {}) {
  if (leftOpen && !rightOpen) return 1;
  if (rightOpen && !leftOpen) return 2;

  if (toNumber(leftPoints) !== toNumber(rightPoints)) {
    return toNumber(leftPoints) < toNumber(rightPoints) ? 1 : 2;
  }

  if (toNumber(leftCount) !== toNumber(rightCount)) {
    return toNumber(leftCount) < toNumber(rightCount) ? 1 : 2;
  }

  return 1;
}

async function getDirectChildren(uid, conn = pool) {
  const [rows] = await conn.query(
    'SELECT uid, position, id FROM usertab WHERE refid = ? ORDER BY position ASC, id ASC',
    [uid]
  );
  return rows;
}

async function getBranchStats(branchRootUid, conn = pool) {
  if (!branchRootUid) {
    return { memberCount: 0, pointTotal: 0 };
  }

  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS member_count,
              COALESCE(SUM(u.binarypoints), 0) AS point_total
       FROM binary_tree_closuretab c
       INNER JOIN usertab u ON u.uid = c.descendant_uid
       WHERE c.ancestor_uid = ?`,
      [branchRootUid]
    );

    return {
      memberCount: toNumber(rows[0]?.member_count),
      pointTotal: toNumber(rows[0]?.point_total),
    };
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }

  const queue = [toNumber(branchRootUid)];
  const visited = new Set();
  let memberCount = 0;
  let pointTotal = 0;

  while (queue.length > 0) {
    const currentUid = queue.shift();
    if (!currentUid || visited.has(currentUid)) continue;
    visited.add(currentUid);

    const [rows] = await conn.query(
      'SELECT uid, binarypoints FROM usertab WHERE uid = ? OR refid = ? ORDER BY id ASC',
      [currentUid, currentUid]
    );

    for (const row of rows) {
      const rowUid = toNumber(row.uid);
      if (!rowUid || visited.has(rowUid)) continue;
      queue.push(rowUid);
    }

    const [selfRows] = await conn.query(
      'SELECT uid, binarypoints FROM usertab WHERE uid = ? LIMIT 1',
      [currentUid]
    );
    if (selfRows.length > 0) {
      memberCount += 1;
      pointTotal += toNumber(selfRows[0].binarypoints);
    }
  }

  return { memberCount, pointTotal };
}

async function findFirstOpenSlot(startUid, conn = pool) {
  const queue = [toNumber(startUid)];
  const visited = new Set();

  while (queue.length > 0 && visited.size < 5000) {
    const placementUid = queue.shift();
    if (!placementUid || visited.has(placementUid)) continue;
    visited.add(placementUid);

    const children = await getDirectChildren(placementUid, conn);
    const left = children.find((row) => toNumber(row.position) === 1);
    const right = children.find((row) => toNumber(row.position) === 2);

    if (!left) return { placementUid, position: 1 };
    if (!right) return { placementUid, position: 2 };

    queue.push(toNumber(left.uid), toNumber(right.uid));
  }

  throw new Error('No available placement position was found for this branch.');
}

async function findExtremeOpenSlot(startUid, side, conn = pool) {
  const targetSide = toNumber(side) === 2 ? 2 : 1;
  let placementUid = toNumber(startUid);
  const visited = new Set();

  while (placementUid && visited.size < 5000) {
    if (visited.has(placementUid)) {
      throw new Error('Binary placement loop detected while finding an extreme slot.');
    }
    visited.add(placementUid);

    const children = await getDirectChildren(placementUid, conn);
    const next = children.find((row) => toNumber(row.position) === targetSide);
    if (!next) {
      return { placementUid, position: targetSide };
    }

    placementUid = toNumber(next.uid);
  }

  throw new Error('No available extreme placement position was found for this branch.');
}

async function recommendPlacementForSponsor(sponsorUid, conn = pool, options = {}) {
  const normalizedSponsorUid = toNumber(sponsorUid);
  const children = await getDirectChildren(normalizedSponsorUid, conn);
  const leftChild = children.find((row) => toNumber(row.position) === 1);
  const rightChild = children.find((row) => toNumber(row.position) === 2);

  const [leftStats, rightStats] = await Promise.all([
    getBranchStats(leftChild?.uid, conn),
    getBranchStats(rightChild?.uid, conn),
  ]);

  const forcedSide = [1, 2].includes(toNumber(options.forcedSide)) ? toNumber(options.forcedSide) : null;
  const preferredSide = forcedSide || choosePlacementPreference({
    leftOpen: !leftChild,
    rightOpen: !rightChild,
    leftPoints: leftStats.pointTotal,
    rightPoints: rightStats.pointTotal,
    leftCount: leftStats.memberCount,
    rightCount: rightStats.memberCount,
  });

  if (preferredSide === 1 && !leftChild) {
    return {
      placementUid: normalizedSponsorUid,
      position: 1,
      side: 'left',
      branchPointTotal: leftStats.pointTotal,
      branchMemberCount: leftStats.memberCount,
      strategy: forcedSide ? 'forced-extreme-left' : 'extreme-left',
    };
  }

  if (preferredSide === 2 && !rightChild) {
    return {
      placementUid: normalizedSponsorUid,
      position: 2,
      side: 'right',
      branchPointTotal: rightStats.pointTotal,
      branchMemberCount: rightStats.memberCount,
      strategy: forcedSide ? 'forced-extreme-right' : 'extreme-right',
    };
  }

  const branchRootUid = preferredSide === 1 ? toNumber(leftChild?.uid) : toNumber(rightChild?.uid);
  const branchStats = preferredSide === 1 ? leftStats : rightStats;
  const openSlot = await findExtremeOpenSlot(branchRootUid, preferredSide, conn);

  return {
    placementUid: openSlot.placementUid,
    position: openSlot.position,
    side: preferredSide === 1 ? 'left' : 'right',
    branchPointTotal: branchStats.pointTotal,
    branchMemberCount: branchStats.memberCount,
    strategy: preferredSide === 1
      ? (forcedSide ? 'forced-extreme-left' : 'extreme-left')
      : (forcedSide ? 'forced-extreme-right' : 'extreme-right'),
  };
}

module.exports = {
  choosePlacementPreference,
  findExtremeOpenSlot,
  findFirstOpenSlot,
  recommendPlacementForSponsor,
};
