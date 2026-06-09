const express = require('express');
const router = express.Router();
const {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getPurchasedProducts,
  confirmDelivery,
  submitReport,
  getBuyerReports
} = require('../controllers/orders.controller');
const { protect } = require('../middlewares/auth.middleware');
const multer = require('multer');

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/reports/',
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

// Protected routes - all require authentication
router.post('/', protect, createOrder);
router.get('/', protect, getUserOrders);
router.get('/purchased-products', protect, getPurchasedProducts);
router.get('/reports', protect, getBuyerReports);
router.get('/:orderId', protect, getOrderById);
router.put('/:orderId/status', protect, updateOrderStatus);
router.put('/:orderId/cancel', protect, cancelOrder);

// New routes for delivery confirmation and reports
router.post('/:orderId/confirm-delivery', protect, confirmDelivery);
router.post('/:orderId/report', protect, upload.single('evidence'), submitReport);
router.post('/:orderId/retry-payment', protect, require('../controllers/orders.controller').retryOrderPayment);

module.exports = router;