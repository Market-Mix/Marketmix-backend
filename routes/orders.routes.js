const express = require('express');
const router = express.Router();
const {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getPurchasedProducts
} = require('../controllers/orders.controller');
const { protect } = require('../middlewares/auth.middleware');

// Protected routes - all require authentication
router.post('/', protect, createOrder);
router.get('/', protect, getUserOrders);
router.get('/purchased-products', protect, getPurchasedProducts);
router.get('/:orderId', protect, getOrderById);
router.put('/:orderId/status', protect, updateOrderStatus);
router.put('/:orderId/cancel', protect, cancelOrder);

module.exports = router;