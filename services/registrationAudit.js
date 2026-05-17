function jsonOrNull(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

async function appendPlacementAudit(conn, payload) {
  await conn.query(
    `INSERT INTO binary_placement_audittab
     (sponsor_uid, placement_uid, created_uid, requested_position, enforced_position,
      policy_mode, policy_reason, referral_token, process_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.sponsorUid,
      payload.placementUid,
      payload.createdUid || null,
      payload.requestedPosition == null ? null : Number(payload.requestedPosition),
      Number(payload.enforcedPosition),
      payload.policyMode,
      payload.policyReason,
      payload.referralToken || null,
      payload.processKey,
    ]
  );
}

async function appendActivationCodeUsage(conn, payload) {
  await conn.query(
    `INSERT INTO activation_code_usagetab
     (code, code_row_id, event_type, from_uid, to_uid, actor_uid, actor_admin_id,
      referral_token, registration_uid, upgrade_uid, notes, process_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.code,
      payload.codeRowId || null,
      payload.eventType,
      payload.fromUid || null,
      payload.toUid || null,
      payload.actorUid || null,
      payload.actorAdminId || null,
      payload.referralToken || null,
      payload.registrationUid || null,
      payload.upgradeUid || null,
      jsonOrNull(payload.notes),
      payload.processKey,
    ]
  );
}

module.exports = {
  appendPlacementAudit,
  appendActivationCodeUsage,
};
