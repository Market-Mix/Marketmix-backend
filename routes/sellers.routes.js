const express = require('express');
const router = express.Router();
const { setupSellerProfile, getSellerProfile } = require('../controllers/sellers.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// Public health check — confirms this file is loaded
// GET /api/seller/ping
router.get('/ping', (req, res) => {
  res.json({ status: 'success', message: 'Seller routes loaded ✅' });
});

// GET /api/seller/profile — get own seller profile
router.get('/profile', protect, isSeller, getSellerProfile);

// POST /api/seller/setup-profile — save store details after registration
router.post('/setup-profile', protect, isSeller, setupSellerProfile);

module.exports = router;