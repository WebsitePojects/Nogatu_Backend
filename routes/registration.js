/**
 * Registration Routes
 * 1:1 port of PHP new-account-registration.php + registration-fnc.php AJAX endpoints
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const registrationService = require('../services/registration');
const { calculateAndStoreIncome } = require('../services/income/calculateAndStoreIncome');
const { createReferralSlug, normalizeReferralSlug, createPublicId } = require('../utils/security');
const { resolveTin, isValidTin } = require('../utils/tin');
const { writeAuditLog } = require('../services/audit');
const { recommendPlacementForSponsor } = require('../services/placementRecommendation');
const {
  getPlacementPolicyForSponsor,
  placementPolicyMessage,
} = require('../services/binaryPlacementPolicy');
const { SCHEMA_REQUIREMENTS, assertSchemaRequirements } = require('../services/schemaReadiness');

async function ensureReferralInvitesTable() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.PUBLIC_REGISTRATION, 'Referral registration');
}

async function ensurePublicIdentityColumns() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.PUBLIC_REGISTRATION, 'Referral registration');
}

async function ensurePublicRegistrationAuditColumns() {
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.PUBLIC_REGISTRATION, 'Referral registration');
}

async function ensureReferralSlug(uid) {
  await ensurePublicIdentityColumns();
  const [rows] = await pool.query('SELECT public_uid, referral_slug FROM usertab WHERE uid = ? LIMIT 1', [uid]);
  if (rows.length === 0) return null;
  let publicUid = rows[0].public_uid;
  let slug = rows[0].referral_slug;

  if (!publicUid) publicUid = createPublicId();
  if (!slug) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      slug = createReferralSlug(8);
      const [existing] = await pool.query('SELECT uid FROM usertab WHERE referral_slug = ? LIMIT 1', [slug]);
      if (existing.length === 0) break;
    }
  }

  await pool.query(
    'UPDATE usertab SET public_uid = ?, referral_slug = ? WHERE uid = ? LIMIT 1',
    [publicUid, slug, uid]
  );
  return { publicUid, slug };
}

async function buildPlacementPreview(sponsorUid, conn = pool) {
  const placementPolicy = await getPlacementPolicyForSponsor(Number(sponsorUid), conn);
  const placement = await recommendPlacementForSponsor(Number(sponsorUid), conn);
  const [rows] = await conn.query(
    'SELECT username FROM memberstab WHERE uid = ? LIMIT 1',
    [placement.placementUid]
  );

  return {
    ...placement,
    placementUsername: rows[0]?.username || null,
    positionLabel: Number(placement.position) === 1 ? 'Left' : 'Right',
    note: placementPolicyMessage(placementPolicy),
    placementPolicy,
  };
}

async function writeDuplicateRegistrationAudit(req, sponsorUid, details, attemptedIdentity) {
  await writeAuditLog({
    req,
    actorUid: Number(sponsorUid) || null,
    actorRole: 'member',
    action: 'registration.duplicate_blocked',
    targetUid: Number(details?.matchedUid || 0) || null,
    targetTable: 'memberstab',
    targetId: details?.matchedUid ? String(details.matchedUid) : null,
    beforeState: {
      attemptedIdentity,
    },
    afterState: {
      blocked: true,
      normalizedName: details?.normalizedName || '',
      matchedSignals: details?.matchedSignals || [],
      reason: details?.reason || 'name-plus-strong-signal-match',
    },
  }).catch(() => {});
}

async function refreshSponsorIncomeAfterRegistration(sponsorUid, fallbackAcctType = 0) {
  const numericSponsorUid = Number(sponsorUid || 0);
  if (!numericSponsorUid) return;

  try {
    const [rows] = await pool.query(
      'SELECT currentaccttype, accttype FROM usertab WHERE uid = ? LIMIT 1',
      [numericSponsorUid]
    );
    const sponsorAcctType = Number(
      rows[0]?.currentaccttype ||
      rows[0]?.accttype ||
      fallbackAcctType ||
      0
    );
    await calculateAndStoreIncome(numericSponsorUid, sponsorAcctType);
  } catch (error) {
    console.error('[Registration] Sponsor income refresh warning:', error);
  }
}

/**
 * GET /api/registration/validate-code?code=XXX
 * AJAX validation: check if activation code is valid
 */
router.get('/validate-code', async (req, res) => {
  try {
    const { code } = req.query;
    const preview = await registrationService.previewActivationCode(code || '');
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/validate-username?username=XXX
 * AJAX validation: check if username already exists
 */
router.get('/validate-username', async (req, res) => {
  try {
    const { username } = req.query;
    const exists = await registrationService.checkUsername(username || '');
    res.json({ exists });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/validate-sponsor?sponsorid=XXX
 * AJAX validation: check if sponsor exists
 */
router.get('/validate-sponsor', async (req, res) => {
  try {
    const { sponsorid } = req.query;
    const exists = await registrationService.checkUsername(sponsorid || '');
    res.json({ exists });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/validate-placement?placementid=XXX
 * AJAX validation: check if placement has available slots
 */
router.get('/validate-placement', async (req, res) => {
  try {
    const { placementid } = req.query;
    const uid = await registrationService.getAccountId(placementid || '');
    if (!uid) return res.json({ valid: false });

    const full = await registrationService.checkPlacementSlots(uid);
    res.json({ valid: !full });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/available-position?placementUid=XXX
 * Get available position (1=left, 2=right, 0=none)
 */
router.get('/available-position', memberAuth, async (req, res) => {
  try {
    const { placementUid } = req.query;
    const position = await registrationService.getAvailablePosition(Number(placementUid));
    res.json({ position });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/default-placement', memberAuth, async (req, res) => {
  try {
    const placement = await buildPlacementPreview(Number(req.session.uid));
    res.json({ placement });
  } catch (err) {
    console.error('[Registration] Default placement error:', err);
    res.status(500).json({ error: 'Unable to load the recommended placement right now.' });
  }
});

/**
 * GET /api/registration/check-duplicate-name?firstname=XXX&lastname=XXX
 * Check for one-name duplicates (DOC2 §4.4)
 */
router.get('/check-duplicate-name', memberAuth, async (req, res) => {
  try {
    const { firstname, lastname } = req.query;
    const result = await registrationService.checkDuplicateName(firstname || '', lastname || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/available-codes?package_type=10
 * Auto-fill registration codes from sponsor's inventory (DOC2 §4.5)
 */
router.get('/available-codes', memberAuth, async (req, res) => {
  try {
    const sponsorUid = req.session.uid;
    const packageType = Number(req.query.package_type || 0);

    const codes = await registrationService.getAvailableCodes(sponsorUid, packageType);
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/registration/referral-invite
 * Returns the current active self-registration referral invite for the member.
 */
router.get('/referral-invite', memberAuth, async (req, res) => {
  try {
    await ensureReferralInvitesTable();
    const [rows] = await pool.query(
      `SELECT token, sponsor_uid, placement_uid, position,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM referral_invitestab
       WHERE sponsor_uid = ? AND active = 1
       ORDER BY id DESC LIMIT 1`,
      [req.session.uid]
    );
    res.json({ invite: rows[0] || null });
  } catch (err) {
    console.error('[Registration] Referral invite fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/referral-link', memberAuth, async (req, res) => {
  try {
    const identity = await ensureReferralSlug(Number(req.session.uid));
    if (!identity) return res.status(404).json({ error: 'Sponsor account not found.' });
    const placement = await buildPlacementPreview(Number(req.session.uid));

    res.json({
      slug: identity.slug,
      publicUid: identity.publicUid,
      placementMode: placement?.placementPolicy?.mode || 'manual',
      placement,
    });
  } catch (err) {
    console.error('[Registration] referral link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/registration/referral-invite
 * Regenerates a referral invite tied to the sponsor's next open binary position.
 */
router.post('/referral-invite', memberAuth, async (req, res) => {
  try {
    await ensureReferralInvitesTable();
    const sponsorUid = Number(req.session.uid);
    const placementPolicy = await getPlacementPolicyForSponsor(sponsorUid);
    const placementUid = Number(req.body?.placementUid || 0);
    const requestedPosition = Number(req.body?.position || 0);
    const placement = (placementPolicy.mode === 'manual' && placementUid && [1, 2].includes(requestedPosition))
      ? {
          placementUid,
          position: requestedPosition,
          positionLabel: requestedPosition === 1 ? 'Left' : 'Right',
          side: requestedPosition === 1 ? 'left' : 'right',
          strategy: 'manual',
          note: 'Manual placement was selected for this referral invite.',
          placementPolicy,
        }
      : await buildPlacementPreview(sponsorUid);

    const occupied = await registrationService.checkPlacement(placement.placementUid, placement.position);
    if (occupied) {
      return res.status(400).json({ error: 'Selected placement position is already taken.' });
    }

    const token = crypto.randomBytes(18).toString('hex');
    await pool.query('UPDATE referral_invitestab SET active = 0 WHERE sponsor_uid = ?', [sponsorUid]);
    await pool.query(
      `INSERT INTO referral_invitestab (sponsor_uid, placement_uid, position, token, active, created_at)
       VALUES (?, ?, ?, ?, 1, NOW())`,
      [sponsorUid, placement.placementUid, placement.position, token]
    );

    res.json({
      invite: {
        token,
        sponsor_uid: sponsorUid,
        placement_uid: placement.placementUid,
        position: placement.position,
        placement,
      },
    });
  } catch (err) {
    console.error('[Registration] Referral invite create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/referral/:token', async (req, res) => {
  try {
    await ensurePublicIdentityColumns();
    const slug = normalizeReferralSlug(req.params.token || '');
    if (slug) {
      const [slugRows] = await pool.query(
        `SELECT u.uid AS sponsor_uid, u.public_uid AS sponsor_public_uid, u.referral_slug,
                m.username AS sponsor_username
         FROM usertab u
         INNER JOIN memberstab m ON m.uid = u.uid
         WHERE u.referral_slug = ?
         LIMIT 1`,
        [slug]
      );
      if (slugRows.length > 0) {
        const placement = await buildPlacementPreview(Number(slugRows[0].sponsor_uid));
        return res.json({
          invite: {
            token: slug,
            referral_slug: slug,
            sponsor_uid: slugRows[0].sponsor_uid,
            sponsor_public_uid: slugRows[0].sponsor_public_uid,
            sponsor_username: slugRows[0].sponsor_username,
            reusable: true,
            placement_uid: placement.placementUid,
            position: placement.position,
            placement,
          },
        });
      }
    }

    await ensureReferralInvitesTable();
    const [rows] = await pool.query(
      `SELECT ri.token, ri.sponsor_uid, ri.placement_uid, ri.position, m.username AS sponsor_username
       FROM referral_invitestab ri
       INNER JOIN memberstab m ON m.uid = ri.sponsor_uid
       WHERE ri.token = ? AND ri.active = 1 LIMIT 1`,
      [String(req.params.token || '')]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Referral invite not found or expired.' });
    const livePlacement = await buildPlacementPreview(Number(rows[0].sponsor_uid));
    const placement = {
      ...livePlacement,
      placementUid: Number(rows[0].placement_uid),
      position: Number(rows[0].position),
      side: Number(rows[0].position) === 2 ? 'right' : 'left',
      positionLabel: Number(rows[0].position) === 2 ? 'Right' : 'Left',
      note: 'Placement is reserved by this referral invite. The backend will re-check it before saving.',
    };
    res.json({ invite: { ...rows[0], placement } });
  } catch (err) {
    console.error('[Registration] Public referral lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/public-register', async (req, res) => {
  try {
    await ensureReferralInvitesTable();
    const {
      token, slug, activationCode, username, password,
      firstname, lastname, middlename, tin, email, address, deviceFingerprint, contactno, dob
    } = req.body;

    if (!(token || slug) || !activationCode || !username || !password || !firstname || !lastname || !email || !contactno || !dob || !address) {
      return res.status(400).json({ error: 'All required fields must be filled' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (password.length < 6 || password.length > 50) {
      return res.status(400).json({ error: 'Password must be 6-50 characters' });
    }

    let invite;
    let reusableSlug = false;
    let placement;
    const requestedPlacementUid = Number(req.body?.placementUid || 0);
    const requestedPosition = Number(req.body?.position || 0);
    if (slug) {
      const normalizedSlug = normalizeReferralSlug(slug);
      const [sponsorRows] = await pool.query(
        'SELECT uid, referral_slug FROM usertab WHERE referral_slug = ? LIMIT 1',
        [normalizedSlug]
      );
      if (sponsorRows.length === 0) return res.status(404).json({ error: 'Referral invite not found or expired.' });
      const defaultPlacement = await buildPlacementPreview(Number(sponsorRows[0].uid));
      placement = (requestedPlacementUid && [1, 2].includes(requestedPosition))
        ? {
            ...defaultPlacement,
            placementUid: requestedPlacementUid,
            position: requestedPosition,
            side: requestedPosition === 2 ? 'right' : 'left',
            positionLabel: requestedPosition === 2 ? 'Right' : 'Left',
            strategy: 'manual',
            note: 'Manual placement was selected for this referral registration.',
          }
        : defaultPlacement;
      invite = {
        sponsor_uid: Number(sponsorRows[0].uid),
        placement_uid: placement.placementUid,
        position: placement.position,
        referral_slug: normalizedSlug,
      };
      reusableSlug = true;
    } else {
      const [rows] = await pool.query(
        `SELECT sponsor_uid, placement_uid, position
         FROM referral_invitestab
         WHERE token = ? AND active = 1 LIMIT 1`,
        [token]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Referral invite not found or expired.' });
      invite = rows[0];
      const livePlacement = await buildPlacementPreview(Number(invite.sponsor_uid));
      placement = {
        ...livePlacement,
        placementUid: Number(invite.placement_uid),
        position: Number(invite.position),
        side: Number(invite.position) === 2 ? 'right' : 'left',
        positionLabel: Number(invite.position) === 2 ? 'Right' : 'Left',
      };
    }

    const result = await registrationService.registerMember({
      activationCode,
      sponsorUid: Number(invite.sponsor_uid),
      placementUid: Number(placement?.placementUid || invite.placement_uid),
      username,
      password,
      firstname,
      lastname,
      middlename,
      tin,
      email,
      address,
      contactno,
      dob,
      position: Number(placement?.position || invite.position),
      requestedPosition: Number(placement?.position || invite.position),
      placementPolicy: placement?.placementPolicy || null,
      referralToken: invite.referral_slug || String(token || '').slice(0, 80),
      requestId: req.requestId || null,
      autoPlacement: !(requestedPlacementUid && [1, 2].includes(requestedPosition)),
    });

    if (!reusableSlug) {
      await pool.query('UPDATE referral_invitestab SET active = 0 WHERE token = ? LIMIT 1', [token]);
    }

    await ensureReferralSlug(Number(result.uid)).catch(() => {});
    await ensurePublicRegistrationAuditColumns();
    await pool.query(
      `INSERT INTO public_registration_audittab
       (registration_uid, sponsor_uid, new_member_uid, referral_slug, activation_code,
        requested_position, enforced_position, placement_policy_mode, placement_policy_reason,
        registration_ip, device_fingerprint, status, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP(6))`,
      [
        createPublicId(),
        Number(invite.sponsor_uid),
        Number(result.uid),
        invite.referral_slug || String(token || '').slice(0, 32),
        activationCode,
        Number(invite.position || 0) || null,
        Number(result.position || 0) || null,
        result.placementPolicy?.mode || null,
        result.placementPolicy?.reason || null,
        req.ip || null,
        String(deviceFingerprint || '').slice(0, 256) || null,
      ]
    ).catch(() => {});

    await writeAuditLog({
      req,
      actorUid: Number(invite.sponsor_uid),
      actorRole: 'member',
      action: 'registration.public_register',
      targetUid: Number(result.uid),
      targetTable: 'usertab',
      targetId: String(result.uid),
      afterState: {
        placementUid: result.placementUid,
        requestedPosition: invite.position,
        enforcedPosition: result.position,
        placementPolicy: result.placementPolicy || null,
      },
    }).catch(() => {});

    await refreshSponsorIncomeAfterRegistration(Number(invite.sponsor_uid));

    res.json(result);
  } catch (err) {
    console.error('[Registration] Public registration error:', err);
    if (err.code === 'DUPLICATE_ACCOUNT') {
      await writeDuplicateRegistrationAudit(req, Number(req.body?.sponsorUid || 0), err.details, {
        firstname: req.body?.firstname,
        lastname: req.body?.lastname,
        middlename: req.body?.middlename,
        tin: req.body?.tin,
        email: req.body?.email,
        contactno: req.body?.contactno,
        dob: req.body?.dob,
        address: req.body?.address,
      });
      return res.status(400).json({
        error: err.message,
        errorCode: 'DUPLICATE_ACCOUNT',
        popup: true,
        duplicatePolicy: {
          blocked: true,
          reason: err.details?.reason || 'name-plus-strong-signal-match',
        },
      });
    }
    if (err.code === 'USERNAME_TAKEN') {
      return res.status(400).json({
        error: err.message,
        errorCode: err.code,
        popup: true,
        field: 'username',
      });
    }
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/registration/register
 * Full account registration
 */
router.post('/register', memberAuth, async (req, res) => {
  try {
    const {
      activationCode, placementUid, username, password,
      firstname, lastname, middlename, position, tin, tinno, email, address, contactno, dob
    } = req.body;

    const rawTin = resolveTin({ tin, tinno });

    // Input validation
    if (!activationCode || !username || !password || !firstname || !lastname || !email || !contactno || !dob || !address) {
      return res.status(400).json({ error: 'All required fields must be filled' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (password.length < 6 || password.length > 50) {
      return res.status(400).json({ error: 'Password must be 6-50 characters' });
    }
    if (firstname.length > 50 || lastname.length > 50) {
      return res.status(400).json({ error: 'Name fields must be under 50 characters' });
    }

    if (rawTin && !isValidTin(rawTin)) {
      return res.status(400).json({ error: 'TIN must be 9–12 digits (e.g. 123-456-789-000). Use 000-000-000-000 if you do not have a TIN.' });
    }

    const recommendedPlacement = await buildPlacementPreview(Number(req.session.uid));
    const finalPlacementUid = !placementUid
      ? Number(recommendedPlacement.placementUid)
      : Number(placementUid);
    const finalPosition = !placementUid
      ? Number(recommendedPlacement.position)
      : Number(position);

    const result = await registrationService.registerMember({
      activationCode,
      sponsorUid: req.session.uid,
      placementUid: finalPlacementUid,
      username,
      password,
      firstname,
      lastname,
      middlename,
      tin: rawTin,
      email,
      address,
      contactno,
      dob,
      position: finalPosition,
      requestedPosition: Number(position),
      placementPolicy: recommendedPlacement?.placementPolicy || null,
      requestId: req.requestId || null,
      autoPlacement: !placementUid,
    });

    await refreshSponsorIncomeAfterRegistration(
      Number(req.session.uid),
      Number(req.session.currentaccttype || req.session.accttype || 0)
    );

    res.json(result);
  } catch (err) {
    // Only write to error.log for unexpected system errors (e.g. DB failures).
    // User-input validation rejections (plain Error, no code) and known business
    // rule codes go to warn so they don't pollute the PM2 error stream.
    const isKnownCode = err.code === 'DUPLICATE_ACCOUNT' || err.code === 'USERNAME_TAKEN';
    if (!isKnownCode && err.code) {
      console.error('[Registration] Error:', err);
    } else if (!isKnownCode) {
      console.warn('[Registration] Rejected:', err.message);
    }
    if (err.code === 'DUPLICATE_ACCOUNT') {
      await writeDuplicateRegistrationAudit(req, Number(req.session.uid), err.details, {
        firstname: req.body?.firstname,
        lastname: req.body?.lastname,
        middlename: req.body?.middlename,
        tin: req.body?.tin || req.body?.tinno,
        email: req.body?.email,
        contactno: req.body?.contactno,
        dob: req.body?.dob,
        address: req.body?.address,
      });
      return res.status(400).json({
        error: err.message,
        errorCode: 'DUPLICATE_ACCOUNT',
        popup: true,
        duplicatePolicy: {
          blocked: true,
          reason: err.details?.reason || 'name-plus-strong-signal-match',
        },
      });
    }
    if (err.code === 'USERNAME_TAKEN') {
      return res.status(400).json({
        error: err.message,
        errorCode: err.code,
        popup: true,
        field: 'username',
      });
    }
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
