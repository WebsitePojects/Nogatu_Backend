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
const { resolveTin, isValidTin } = require('../utils/tin');
const { createReferralSlug, normalizeReferralSlug, createPublicId } = require('../utils/security');
const { writeAuditLog } = require('../services/audit');
const { recommendPlacementForSponsor } = require('../services/placementRecommendation');

async function ensureReferralInvitesTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS referral_invitestab (
      id INT NOT NULL AUTO_INCREMENT,
      sponsor_uid INT NOT NULL,
      placement_uid INT NOT NULL,
      position TINYINT NOT NULL,
      token VARCHAR(80) NOT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_referral_token (token),
      KEY idx_sponsor_active (sponsor_uid, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function ensurePublicIdentityColumns() {
  const [publicUidCols] = await pool.query("SHOW COLUMNS FROM usertab LIKE 'public_uid'");
  if (publicUidCols.length === 0) {
    await pool.query('ALTER TABLE usertab ADD COLUMN public_uid CHAR(36) NULL');
  }
  const [slugCols] = await pool.query("SHOW COLUMNS FROM usertab LIKE 'referral_slug'");
  if (slugCols.length === 0) {
    await pool.query('ALTER TABLE usertab ADD COLUMN referral_slug VARCHAR(32) NULL');
  }
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
  const placement = await recommendPlacementForSponsor(Number(sponsorUid), conn);
  const [rows] = await conn.query(
    'SELECT username FROM memberstab WHERE uid = ? LIMIT 1',
    [placement.placementUid]
  );

  return {
    ...placement,
    placementUsername: rows[0]?.username || null,
    positionLabel: Number(placement.position) === 1 ? 'Left' : 'Right',
    note: 'System auto-assigns placement on the weak leg to help generate guaranteed binary points.',
  };
}

/**
 * GET /api/registration/validate-code?code=XXX
 * AJAX validation: check if activation code is valid
 */
router.get('/validate-code', async (req, res) => {
  try {
    const { code } = req.query;
    const isValid = await registrationService.validateCode(code || '');
    res.json({ valid: isValid });
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
    const packageType = Number(req.query.package_type);

    if (!packageType) {
      return res.status(400).json({ error: 'Package type is required' });
    }

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
      placementMode: 'weak-leg',
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
    const placementUid = Number(req.body?.placementUid || 0);
    const requestedPosition = Number(req.body?.position || 0);
    const placement = (placementUid && [1, 2].includes(requestedPosition))
      ? {
          placementUid,
          position: requestedPosition,
          positionLabel: requestedPosition === 1 ? 'Left' : 'Right',
          side: requestedPosition === 1 ? 'left' : 'right',
          strategy: 'manual',
          note: 'Manual placement was selected for this referral invite.',
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
        return res.json({
          invite: {
            token: slug,
            referral_slug: slug,
            sponsor_uid: slugRows[0].sponsor_uid,
            sponsor_public_uid: slugRows[0].sponsor_public_uid,
            sponsor_username: slugRows[0].sponsor_username,
            reusable: true,
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
    res.json({ invite: rows[0] });
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
      firstname, lastname, middlename, tin, email, deviceFingerprint
    } = req.body;

    if (!(token || slug) || !activationCode || !username || !password || !firstname || !lastname || !email) {
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
    if (slug) {
      const normalizedSlug = normalizeReferralSlug(slug);
      const [sponsorRows] = await pool.query(
        'SELECT uid, referral_slug FROM usertab WHERE referral_slug = ? LIMIT 1',
        [normalizedSlug]
      );
      if (sponsorRows.length === 0) return res.status(404).json({ error: 'Referral invite not found or expired.' });
      const placement = await buildPlacementPreview(Number(sponsorRows[0].uid));
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
    }

    const result = await registrationService.registerMember({
      activationCode,
      sponsorUid: Number(invite.sponsor_uid),
      placementUid: Number(invite.placement_uid),
      username,
      password,
      firstname,
      lastname,
      middlename,
      tin,
      email,
      position: Number(invite.position),
    });

    if (!reusableSlug) {
      await pool.query('UPDATE referral_invitestab SET active = 0 WHERE token = ? LIMIT 1', [token]);
    }

    await ensureReferralSlug(Number(result.uid)).catch(() => {});
    await pool.query(
      `INSERT INTO public_registration_audittab
       (registration_uid, sponsor_uid, new_member_uid, referral_slug, activation_code,
        registration_ip, device_fingerprint, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        createPublicId(),
        Number(invite.sponsor_uid),
        Number(result.uid),
        invite.referral_slug || String(token || '').slice(0, 32),
        activationCode,
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
      afterState: { placementUid: invite.placement_uid, position: invite.position },
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error('[Registration] Public registration error:', err);
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
      firstname, lastname, middlename, position, tin, tinno, email
    } = req.body;

    const rawTin = String(tin || tinno || '').trim();

    // Input validation
    if (!activationCode || !username || !password || !firstname || !lastname || !rawTin || !email) {
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

    if (rawTin.length < 9 || rawTin.length > 30 || !/^[0-9-]+$/.test(rawTin)) {
      return res.status(400).json({ error: 'TIN must be 9-30 characters using digits and dashes only' });
    }

    const recommendedPlacement = !placementUid
      ? await buildPlacementPreview(Number(req.session.uid))
      : null;

    const result = await registrationService.registerMember({
      activationCode,
      sponsorUid: req.session.uid,
      placementUid: recommendedPlacement ? Number(recommendedPlacement.placementUid) : Number(placementUid),
      username,
      password,
      firstname,
      lastname,
      middlename,
      tin: rawTin,
      email,
      position: recommendedPlacement ? Number(recommendedPlacement.position) : Number(position),
    });

    res.json(result);
  } catch (err) {
    console.error('[Registration] Error:', err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
