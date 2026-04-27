const express = require('express');
const router = express.Router();
const { getWithdrawals, requestWithdrawal } = require('../controllers/withdrawal.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// Apply protection to all withdrawal routes
router.use(protect);
router.use(isSeller);

/**
 * @route   GET /api/withdrawals
 * @desc    Get seller withdrawal history
 * @access  Private (Seller)
 */
router.get('/', getWithdrawals);

/**
 * @route   POST /api/withdrawals
 * @desc    Request a withdrawal
 * @access  Private (Seller)
 */
router.post('/', requestWithdrawal);

module.exports = router;
