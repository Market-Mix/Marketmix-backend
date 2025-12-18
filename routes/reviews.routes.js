const express = require('express');
const router = express.Router();
const {
  getMyReviews,
  createReview,
  updateReview,
  deleteReview,
  getProductReviews,
  voteReview,
  reportReview
} = require('../controllers/reviews.controller');
const { protect } = require('../middlewares/auth.middleware');

// =====================================================
// BUYER ROUTES (Protected - Requires Authentication)
// =====================================================

/**
 * @route   GET /api/reviews/my-reviews
 * @desc    Get all reviews written by current user
 * @access  Private (Buyer)
 */
router.get('/my-reviews', protect, getMyReviews);

/**
 * @route   POST /api/reviews
 * @desc    Create a new review for a product
 * @access  Private (Buyer)
 * @body    { product_id, order_id?, rating, body, media? }
 */
router.post('/', protect, createReview);

/**
 * @route   PUT /api/reviews/:id
 * @desc    Update an existing review
 * @access  Private (Buyer - owns review)
 * @body    { rating?, body? }
 */
router.put('/:id', protect, updateReview);

/**
 * @route   DELETE /api/reviews/:id
 * @desc    Delete a review (soft delete)
 * @access  Private (Buyer - owns review)
 */
router.delete('/:id', protect, deleteReview);

/**
 * @route   POST /api/reviews/:id/vote
 * @desc    Vote a review as helpful or not helpful
 * @access  Private (Any authenticated user)
 * @body    { voteType: 'helpful' | 'not_helpful' }
 */
router.post('/:id/vote', protect, voteReview);

/**
 * @route   POST /api/reviews/:id/report
 * @desc    Report a review for moderation
 * @access  Private (Any authenticated user)
 * @body    { reason: 'spam' | 'offensive' | 'misleading' | 'other', details? }
 */
router.post('/:id/report', protect, reportReview);

// =====================================================
// PUBLIC ROUTES (No Authentication Required)
// =====================================================

/**
 * @route   GET /api/reviews/product/:productId
 * @desc    Get all reviews for a specific product
 * @access  Public
 * @query   page, limit, rating
 */
router.get('/product/:productId', getProductReviews);

module.exports = router;