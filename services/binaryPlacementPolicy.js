const { pool } = require('../config/database');

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function mapPositionLabel(position) {
  return toNumber(position) === 2 ? 'Right' : 'Left';
}

function buildForcedPolicy(forcedPosition, reason, extras = {}) {
  return {
    mode: 'forced',
    forcedPosition: toNumber(forcedPosition),
    forcedPositionLabel: mapPositionLabel(forcedPosition),
    reason,
    hasDirectRecruits: false,
    autoRerouteOnConflict: true,
    ...extras,
  };
}

function buildManualPolicy(reason, extras = {}) {
  return {
    mode: 'manual',
    forcedPosition: null,
    forcedPositionLabel: null,
    reason,
    hasDirectRecruits: true,
    autoRerouteOnConflict: false,
    ...extras,
  };
}

async function getSponsorPlacementContext(sponsorUid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT uid, refid, drefid, position
       FROM usertab
      WHERE uid = ?
      LIMIT 1`,
    [sponsorUid]
  );
  return rows[0] || null;
}

async function countDirectRecruits(sponsorUid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total_direct
       FROM usertab
      WHERE drefid = ?`,
    [sponsorUid]
  );
  return toNumber(rows[0]?.total_direct);
}

async function getPlacementPolicyForSponsor(sponsorUid, conn = pool) {
  const sponsor = await getSponsorPlacementContext(sponsorUid, conn);
  if (!sponsor) {
    throw new Error('Sponsor account not found.');
  }

  const totalDirect = await countDirectRecruits(sponsorUid, conn);
  if (totalDirect >= 1) {
    return buildManualPolicy('first-direct-recruit-already-satisfied', {
      sponsorUid: toNumber(sponsor.uid),
      sponsorPosition: sponsor.position == null ? null : toNumber(sponsor.position),
      totalDirectRecruits: totalDirect,
    });
  }

  if (!toNumber(sponsor.refid) || toNumber(sponsor.refid) === toNumber(sponsor.uid)) {
    return buildForcedPolicy(1, 'root-sponsor-default-left', {
      sponsorUid: toNumber(sponsor.uid),
      sponsorPosition: null,
      totalDirectRecruits: totalDirect,
    });
  }

  if (toNumber(sponsor.position) === 2) {
    return buildForcedPolicy(2, 'inherits-right-from-parent-position', {
      sponsorUid: toNumber(sponsor.uid),
      sponsorPosition: 2,
      totalDirectRecruits: totalDirect,
    });
  }

  return buildForcedPolicy(1, 'inherits-left-from-parent-position', {
    sponsorUid: toNumber(sponsor.uid),
    sponsorPosition: 1,
    totalDirectRecruits: totalDirect,
  });
}

function applyPlacementPolicy(policy, requestedPosition) {
  if (!policy || policy.mode !== 'forced') {
    return {
      requestedPosition: requestedPosition == null ? null : toNumber(requestedPosition),
      enforcedPosition: requestedPosition == null ? null : toNumber(requestedPosition),
      wasOverridden: false,
      policy,
    };
  }

  const normalizedRequested = requestedPosition == null ? null : toNumber(requestedPosition);
  const enforcedPosition = toNumber(policy.forcedPosition);

  return {
    requestedPosition: normalizedRequested,
    enforcedPosition,
    wasOverridden: normalizedRequested !== null && normalizedRequested !== enforcedPosition,
    policy,
  };
}

function placementPolicyMessage(policy) {
  if (!policy) return '';
  if (policy.mode === 'forced') {
    return `Your first direct recruit must be placed on the ${policy.forcedPositionLabel} leg.`;
  }
  return 'You can choose the left or right placement for your next direct recruit, subject to slot availability.';
}

module.exports = {
  getSponsorPlacementContext,
  countDirectRecruits,
  getPlacementPolicyForSponsor,
  applyPlacementPolicy,
  placementPolicyMessage,
};
