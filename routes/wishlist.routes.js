const express = require('express');
const router = express.Router();
const wishlist = require('../controllers/wishlist.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.post('/add', authenticate, wishlist.addToWishlist);
router.get('/', authenticate, wishlist.getWishlist);

module.exports = router;
