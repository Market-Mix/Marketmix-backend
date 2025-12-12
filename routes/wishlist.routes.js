const express = require('express');
const router = express.Router();
const wishlist = require('../controllers/wishlist.controller');
const { protect } = require('../middlewares/auth.middleware');

// Authenticated wishlist endpoints
router.post('/add', protect, wishlist.addToWishlist);
router.get('/', protect, wishlist.getWishlist);

// Guest wishlist endpoints (no auth required)
router.post('/guest/create', wishlist.createGuestWishlist);
router.post('/guest/add', wishlist.addToGuestWishlist);

module.exports = router;
