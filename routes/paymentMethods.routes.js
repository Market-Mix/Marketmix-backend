const express = require('express');
const router = express.Router();
const paymentMethodsController = require('../controllers/paymentMethods.controller');
const { protect } = require('../middlewaressfc/auth.middleware'); // <-- your JWT auth middleware

// Apply authentication middleware to all routes
router.use(protect);

// Routes
router.get('/', paymentMethodsController.getAllPaymentMethods);
router.get('/default', paymentMethodsController.getDefaultPaymentMethod);
router.get('/:id', paymentMethodsController.getPaymentMethodById);
router.post('/', paymentMethodsController.createPaymentMethod);
router.put('/:id', paymentMethodsController.updatePaymentMethod);
router.put('/:id/set-default', paymentMethodsController.updatePaymentMethod); // <-- use correct function
router.delete('/:id', paymentMethodsController.deletePaymentMethod);

module.exports = router;
