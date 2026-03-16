/**
 * Hi-Five Bonus Routes
 * 1:1 port of PHP hifive-bonus.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { checkH5Bonus, getDrefPurchase, insertRedeem, PRODUCT_TYPE_TO_KEY } = require('../services/income/hifiveBonus');

const PRODUCT_NAMES = {
  bl: 'Barley', gl: 'Glutathione', glc: 'Gluta w/ Collagen',
  cm: 'Coffee Mix', cd: 'Chocolate Drink', mgt: 'Mangosteen',
  vz: 'Vitamin Zinc', cmm: 'Max Coffee', bkc: 'Black Coffee',
};

/**
 * GET /api/hifive
 * Get Hi-Five bonus status for all products
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const bonuses = await checkH5Bonus(uid);
    const purchases = await getDrefPurchase(uid);

    const products = Object.entries(PRODUCT_NAMES).map(([key, name]) => ({
      key,
      name,
      bonus: bonuses[key] || 0,
      purchases: purchases[key] || 0,
      redeemable: Math.max(0, Math.floor((purchases[key] || 0) / 5) - (bonuses[key] || 0)),
    }));

    res.json({ products });
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
    const { bonusType, quantity } = req.body;

    if (!bonusType || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'Invalid redemption request' });
    }

    await insertRedeem(uid, bonusType, quantity);
    res.json({ success: true });
  } catch (err) {
    console.error('[HiFive] Redeem error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
