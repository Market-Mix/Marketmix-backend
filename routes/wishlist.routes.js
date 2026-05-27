const express = require('express');
const router = express.Router();
const {
  getWithdrawals,
  requestWithdrawal,
  setWithdrawalPin,
  saveBankAccount,
  getBankAccount
} = require('../controllers/withdrawal.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

router.use(protect, isSeller);

router.get('/', getWithdrawals);
router.post('/', requestWithdrawal);
router.post('/set-pin', setWithdrawalPin);
router.post('/bank-account', saveBankAccount);
router.get('/bank-account', getBankAccount);

module.exports = router;