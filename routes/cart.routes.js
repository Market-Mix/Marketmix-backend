const express = require('express');
const router = express.Router();
const {
  addToCart,
  getCart,
  updateCartItem,
  removeFromCart,
  clearCart
} = require('../controllers/cart.controller');
const { protect } = require('../middlewares/auth.middleware');

// Defensive fallback: if `protect` isn't a function in the deployed bundle
// (older deploys or module resolution issues), use a safe middleware that
// returns a 500 error instead of letting Express crash with a TypeError.
const safeProtect = typeof protect === 'function'
  ? protect
  : (req, res, next) => {
      console.error('Auth middleware `protect` is not a function');
      return res.status(500).json({ status: 'error', message: 'Auth middleware misconfigured' });
    };

// Protected routes
router.post('/add', safeProtect, addToCart);
router.get('/', safeProtect, getCart);
router.put('/:cartItemId', safeProtect, updateCartItem);
router.delete('/:cartItemId', safeProtect, removeFromCart);
router.delete('/', safeProtect, clearCart);

module.exports = router;
