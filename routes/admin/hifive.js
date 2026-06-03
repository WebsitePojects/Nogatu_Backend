const express = require('express');
const router = express.Router();
const { adminAuth, adminRights } = require('../../middleware/auth');
const {
  listPackageClaims,
  approvePackageClaim,
  rejectPackageClaim,
  getPackageClaimDetails,
} = require('../../services/income/hifiveBonus');

router.get('/package-claims', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const result = await listPackageClaims({
      page: req.query.page,
      perPage: req.query.perPage,
      status: req.query.status,
      packageKey: req.query.packageKey,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(result);
  } catch (error) {
    console.error('[Admin HiFive] List package claims error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/package-claims/:qualificationUid/approve', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const result = await approvePackageClaim(req.params.qualificationUid, {
      adminUid: req.session.adminid,
      adminNotes: req.body?.adminNotes,
      req,
    });
    res.json({
      success: true,
      message: 'Package Hi-Five claim approved and paid.',
      ...result,
    });
  } catch (error) {
    console.error('[Admin HiFive] Approve package claim error:', error);
    res.status(422).json({ error: error.message || 'Unable to approve claim.' });
  }
});

router.put('/package-claims/:qualificationUid/reject', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const result = await rejectPackageClaim(req.params.qualificationUid, {
      adminUid: req.session.adminid,
      adminNotes: req.body?.adminNotes,
      req,
    });
    res.json({
      success: true,
      message: 'Package Hi-Five claim rejected.',
      ...result,
    });
  } catch (error) {
    console.error('[Admin HiFive] Reject package claim error:', error);
    res.status(422).json({ error: error.message || 'Unable to reject claim.' });
  }
});

router.get('/package-claims/:qualificationUid', adminAuth, adminRights([1, 3]), async (req, res) => {
  try {
    const result = await getPackageClaimDetails(req.params.qualificationUid);
    res.json(result);
  } catch (error) {
    console.error('[Admin HiFive] Package claim details error:', error);
    res.status(422).json({ error: error.message || 'Unable to load claim details.' });
  }
});

module.exports = router;
