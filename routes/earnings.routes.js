const express = require('express');
const router = express.Router();
const { getSellerEarnings } = require('../controllers/earnings.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// Apply protection to all earnings routes
router.use(protect);
router.use(isSeller);

/**
 * @route   GET /api/earnings
 * @desc    Get seller earnings summary and transactions
 * @access  Private (Seller)
 */
router.get('/', getSellerEarnings);

module.exports = router;
