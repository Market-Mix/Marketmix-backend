const express = require('express');
const router = express.Router();
const wishlist = require('../controllers/wishlist.controller');
const { protect } = require('../middlewares/auth.middleware');

router.post('/add', protect, wishlist.addToWishlist);
router.get('/', protect, wishlist.getWishlist);

module.exports = router;
