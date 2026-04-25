const express = require('express');
const router = express.Router();
const {
  getSellerOrders,
  getSellerOrderById,
  updateSellerOrderStatus,
  getSellerOrderStats,
} = require('../controllers/seller_orders.controller');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');

// All routes require authentication + seller role
router.use(protect, isSeller);

/**
 * GET  /api/seller/orders/stats   — summary counts (must come before /:orderId)
 * GET  /api/seller/orders         — paginated order list
 * GET  /api/seller/orders/:id     — single order detail
 * PUT  /api/seller/orders/:id/status — update order status
 */
router.get('/stats', getSellerOrderStats);
router.get('/', getSellerOrders);
router.get('/:orderId', getSellerOrderById);
router.put('/:orderId/status', updateSellerOrderStatus);

module.exports = router;