const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const {
  getPaymentMethods,
  initiatePayment,
  verifyPayment,
  paystackWebhook,
  // flutterwaveWebhook,
  paystackCallback,
  // flutterwaveCallback,
  processRefund,
} = require('../controllers/payment.controller');

// Public
router.get('/methods', getPaymentMethods);
router.get('/paystack/callback', paystackCallback);
// router.get('/flutterwave/callback', flutterwaveCallback);

// Webhooks (no auth - verified by signature)
router.post('/paystack/webhook', paystackWebhook);
// router.post('/flutterwave/webhook', flutterwaveWebhook);

// Protected
router.post('/initiate', protect, initiatePayment);
router.post('/verify', protect, verifyPayment);
router.post('/refund', protect, processRefund); // add isAdmin when ready

module.exports = router;
