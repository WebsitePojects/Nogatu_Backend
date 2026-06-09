const { pool } = require('../config/database');

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function mapPositionLabel(position) {
  return toNumber(position) === 2 ? 'Right' : 'Left';
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
  return buildManualPolicy('manual-placement-allowed', {
    sponsorUid: toNumber(sponsor.uid),
    sponsorPosition: sponsor.position == null ? null : toNumber(sponsor.position),
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
  return 'You can choose the left or right placement for your next direct recruit, subject to slot availability.';
}

module.exports = {
  getSponsorPlacementContext,
  countDirectRecruits,
  getPlacementPolicyForSponsor,
  applyPlacementPolicy,
  placementPolicyMessage,
};
