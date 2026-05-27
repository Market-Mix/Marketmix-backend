const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const {
  addToWishlist,
  getWishlist,
  createGuestWishlist,
  addToGuestWishlist,
  removeFromWishlist
} = require('../controllers/wishlist.controller');

router.post('/add', protect, addToWishlist);
router.get('/', protect, getWishlist);
router.delete('/remove/:id', protect, removeFromWishlist);
router.post('/guest/create', createGuestWishlist);
router.post('/guest/add', addToGuestWishlist);

module.exports = router;