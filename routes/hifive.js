/**
 * Hi-Five Bonus Routes
 * 1:1 port of PHP hifive-bonus.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const {
  buildHiFiveStatus,
  insertProductRedeem,
  submitPackageClaim,
} = require('../services/income/hifiveBonus');

/**
 * GET /api/hifive
 * Get Hi-Five package + product status
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const status = await buildHiFiveStatus(uid);

    res.json(status);
  } catch (err) {
    console.error('[HiFive] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/hifive/redeem
 * Redeem Hi-Five bonus for a product
 */
router.post('/redeem', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const { claimType = 'product', bonusType, quantity } = req.body;
    const claimQty = Math.max(1, Number(quantity) || 1);
    const status = await buildHiFiveStatus(uid);

    if (!bonusType || claimQty < 1) {
      return res.status(400).json({ error: 'Invalid redemption request' });
    }

    if (claimType === 'package') {
      const packageStatus = status.packageBonus.packages.find((item) => item.key === bonusType);
      if (!packageStatus) {
        return res.status(400).json({ error: 'Invalid package Hi-Five type.' });
      }

      if (claimQty > packageStatus.availableClaims) {
        return res.status(422).json({ error: 'Requested package claim exceeds your available Hi-Five package claims.' });
      }

      await submitPackageClaim(uid, bonusType, claimQty);
      return res.json({
        success: true,
        message: `${packageStatus.name} package Hi-Five claim submitted for review.`,
      });
    }

    // Serialize per-uid: re-read + check + insert under an advisory lock so two concurrent
    // redeems can't both pass the availableClaims gate and double-redeem one set (TOCTOU).
    // (reviewer 🟡, 2026-06-21) — advisory lock is connection-held; release in finally.
    const lockName = `hifive_redeem_${uid}`;
    const lockConn = await pool.getConnection();
    try {
      const [[lk]] = await lockConn.query('SELECT GET_LOCK(?, 10) AS got', [lockName]);
      if (!lk || Number(lk.got) !== 1) {
        return res.status(409).json({ error: 'Another redemption is in progress. Please try again.' });
      }

      // Authoritative read UNDER the lock (the earlier read may be stale vs a concurrent redeem).
      const lockedStatus = await buildHiFiveStatus(uid);
      const lockedProduct = lockedStatus.productBonus.products.find((item) => item.key === bonusType);
      if (!lockedProduct) {
        return res.status(400).json({ error: 'Invalid product Hi-Five type.' });
      }
      if (!lockedStatus.productBonus.eligible) {
        return res.status(422).json({
          error: `You need ${lockedStatus.productBonus.pointsNeeded} more maintenance point(s) to redeem Hi-Five products.`,
        });
      }
      if (claimQty > lockedProduct.availableClaims) {
        return res.status(422).json({ error: 'Requested product redemption exceeds your available Hi-Five product claims.' });
      }

      await insertProductRedeem(uid, bonusType, claimQty);
      return res.json({
        success: true,
        message: `${lockedProduct.name} product Hi-Five redemption submitted successfully.`,
      });
    } finally {
      await lockConn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      lockConn.release();
    }
  } catch (err) {
    console.error('[HiFive] Redeem error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
