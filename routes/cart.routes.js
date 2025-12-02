const express = require('express');
const router = express.Router();
const {
  addToCart,
  getCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  mergeCart
} = require('../controllers/cart.controller');
const { protect } = require('../middlewares/auth.middleware');

// Protected routes
router.post('/add', protect, addToCart);
router.post('/merge', protect, mergeCart);
router.get('/', protect, getCart);
router.put('/:cartItemId', protect, updateCartItem);
router.delete('/:cartItemId', protect, removeFromCart);
router.delete('/', protect, clearCart);

module.exports = router;
