const express = require('express');
const router = express.Router();
const db = require('../config/db');                          // ADD THIS
const { sendSuccess, sendError } = require('../utils/response'); // ADD THIS
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

// GET /api/reviews/seller/:sellerId — public seller reviews
router.get('/seller/:sellerId', async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await db.query(
      `SELECT
          r.id,
          r.rating,
          r.comment AS body,
          r.created_at,
          u.first_name,
          u.last_name,
          p.name AS product_name,
          p.main_image_url AS product_image
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       JOIN products p ON r.product_id = p.id
       WHERE p.seller_id = $1 AND r.is_deleted = false AND r.is_approved = true
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [sellerId, parseInt(limit), offset]
    );

    const countRes = await db.query(
      `SELECT
          COUNT(*) AS total,
          AVG(r.rating)::numeric(10,1) AS avg_rating,
          COUNT(*) FILTER (WHERE r.rating = 5) AS five_star,
          COUNT(*) FILTER (WHERE r.rating = 4) AS four_star,
          COUNT(*) FILTER (WHERE r.rating = 3) AS three_star,
          COUNT(*) FILTER (WHERE r.rating = 2) AS two_star,
          COUNT(*) FILTER (WHERE r.rating = 1) AS one_star
       FROM reviews r
       JOIN products p ON r.product_id = p.id
       WHERE p.seller_id = $1 AND r.is_deleted = false AND r.is_approved = true`,
      [sellerId]
    );

    const stats = countRes.rows[0];
    return sendSuccess(res, 200, 'Seller reviews fetched', {
      reviews: result.rows,
      summary: {
        total: parseInt(stats.total),
        avgRating: parseFloat(stats.avg_rating) || 0,
        fiveStar: parseInt(stats.five_star),
        fourStar: parseInt(stats.four_star),
        threeStar: parseInt(stats.three_star),
        twoStar: parseInt(stats.two_star),
        oneStar: parseInt(stats.one_star)
      },
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Seller reviews error:', error);
    return sendError(res, 500, 'Error fetching seller reviews', error);
  }
});


module.exports = router;