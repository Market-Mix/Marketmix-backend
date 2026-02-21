const express = require('express');
const router = express.Router();
const { setupSellerProfile, getSellerProfile } = require('../controllers/sellers.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// GET /api/sellers/profile — get own seller profile
router.get('/profile', protect, isSeller, getSellerProfile);

// POST /api/sellers/setup-profile — save store details after registration
router.post('/setup-profile', protect, isSeller, setupSellerProfile);

module.exports = router;
