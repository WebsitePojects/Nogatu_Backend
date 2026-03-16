/**
 * Registration Routes
 * 1:1 port of PHP new-account-registration.php + registration-fnc.php AJAX endpoints
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const registrationService = require('../services/registration');

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

/**
 * POST /api/registration/register
 * Full account registration
 */
router.post('/register', memberAuth, async (req, res) => {
  try {
    const {
      activationCode, placementUid, username, password,
      firstname, lastname, middlename, position
    } = req.body;

    const result = await registrationService.registerMember({
      activationCode,
      sponsorUid: req.session.uid,
      placementUid: Number(placementUid),
      username,
      password,
      firstname,
      lastname,
      middlename,
      position: Number(position),
    });

    res.json(result);
  } catch (err) {
    console.error('[Registration] Error:', err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
