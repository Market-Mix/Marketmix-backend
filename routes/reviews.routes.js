const express = require('express');
const router = express.Router();
const {
  createReview,
  getProductReviews,
  getMyReviews,
  updateReview,
  deleteReview,
  addReply,
  voteHelpful,
  reportReview
} = require('../controllers/reviews.controller');
const { protect } = require('../middlewares/auth.middleware');

// Public routes
router.get('/product/:productId', getProductReviews);

// Protected routes
router.post('/', protect, createReview);
router.get('/my-reviews', protect, getMyReviews);
router.put('/:reviewId', protect, updateReview);
router.delete('/:reviewId', protect, deleteReview);
router.post('/:reviewId/reply', protect, addReply);
router.post('/:reviewId/vote', protect, voteHelpful);
router.post('/:reviewId/report', protect, reportReview);

module.exports = router;