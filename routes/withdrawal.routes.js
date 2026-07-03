const express = require('express');
const router = express.Router();
const { getWithdrawals, requestWithdrawal, setWithdrawalPin, saveBankAccount, getBankAccount, getBanks, resolveAccountNumber, forgotPin, resetPin } = require('../controllers/withdrawal.controller');
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
router.get('/bank-account', getBankAccount);
router.get('/banks', getBanks);


/**
 * @route   POST /api/withdrawals
 * @desc    Request a withdrawal
 * @access  Private (Seller)
 */
router.post('/', requestWithdrawal);
router.post('/set-pin', setWithdrawalPin);
router.post('/bank-account', saveBankAccount);
router.post('/resolve-account', resolveAccountNumber);
router.post('/forgot-pin', forgotPin);
router.post('/reset-pin', resetPin);

module.exports = router;
