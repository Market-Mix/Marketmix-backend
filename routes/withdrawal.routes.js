const express = require('express');
const router = express.Router();
const { getWithdrawals, requestWithdrawal, setWithdrawalPin, saveBankAccount, getBankAccount, getBanks, resolveAccountNumber, forgotPin, resetPin } = require('../controllers/withdrawal.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller, checkSellerActive } = require('../middlewares/role.middleware');
const { sendSuccess } = require('../utils/response');

// Apply protection to all withdrawal routes
router.use(protect);
router.use(isSeller, checkSellerActive);

/**
 * @route   GET /api/withdrawals
 * @desc    Get seller withdrawal history
 * @access  Private (Seller)
 */
router.get('/', getWithdrawals);
router.get('/bank-account', getBankAccount);
router.get('/banks', getBanks);
router.get('/eligibility', async (req, res) => {
  const { hasUnresolvedCases } = require('../services/withdrawalEligibility.service');
  const result = await hasUnresolvedCases(req.user.id);
  return sendSuccess(res, 200, 'Eligibility checked', result);
});


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
