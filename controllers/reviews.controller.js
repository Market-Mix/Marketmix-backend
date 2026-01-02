const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Get all reviews for current user (buyer)
 * @route   GET /api/reviews/my-reviews
 * @access  Private
 */
const getMyReviews = async (req, res) => {
  try {
    const userId = req.user.id;

    // Simplified query without complex json_agg to avoid errors
    const result = await db.query(
      `SELECT 
        r.id,
        r.product_id AS "productId",
        r.order_id AS "orderId",
        r.rating,
        r.comment AS body,
        r.created_at AS "createdAt",
        r.updated_at AS "updatedAt",
        r.is_approved AS "isApproved",
        COALESCE(p.name, 'Product') AS "productName",
        CASE WHEN r.order_id IS NOT NULL THEN true ELSE false END AS "verifiedPurchase",
        (SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = r.id AND vote_type = 'helpful') AS "helpfulCount",
        COALESCE((SELECT json_agg(
          json_build_object(
            'id', rm.id,
            'type', rm.media_type,
            'url', rm.media_url
          )
        ) FROM review_media rm WHERE rm.review_id = r.id), '[]'::json) AS media,
        COALESCE((SELECT json_agg(
          json_build_object(
            'id', rr.id,
            'text', rr.reply_text,
            'createdAt', rr.created_at
          )
        ) FROM review_replies rr WHERE rr.review_id = r.id), '[]'::json) AS replies,
        CASE WHEN EXISTS(
          SELECT 1 FROM review_reports rp 
          WHERE rp.review_id = r.id AND rp.status IN ('pending', 'reviewed')
        ) THEN 'flagged' ELSE 'active' END AS status
      FROM reviews r
      LEFT JOIN products p ON r.product_id = p.id
      WHERE r.user_id = $1 AND r.is_deleted = FALSE
      ORDER BY r.created_at DESC`,
      [userId]
    );

    return sendSuccess(res, 200, 'Reviews fetched successfully', {
      reviews: result.rows
    });
  } catch (error) {
    console.error('Get my reviews error:', error);
    return sendError(res, 500, 'Error fetching reviews', error);
  }
};

/**
 * @desc    Create a new review
 * @route   POST /api/reviews
 * @access  Private
 */
const createReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { product_id, order_id, rating, body, media } = req.body;

    // Validate required fields
    if (!product_id || !rating || !body) {
      return sendError(res, 400, 'Product ID, rating, and review body are required');
    }

    // Validate rating
    if (rating < 1 || rating > 5) {
      return sendError(res, 400, 'Rating must be between 1 and 5');
    }

    // Validate body length
    if (body.length < 4 || body.length > 1200) {
      return sendError(res, 400, 'Review must be between 4 and 1200 characters');
    }

    // Check if product exists
    const productCheck = await db.query(
      'SELECT id FROM products WHERE id = $1',
      [product_id]
    );

    if (productCheck.rows.length === 0) {
      return sendError(res, 404, 'Product not found');
    }

    // Check if user already reviewed this product
    const existingReview = await db.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [product_id, userId]
    );

    if (existingReview.rows.length > 0) {
      return sendError(res, 409, 'You have already reviewed this product');
    }

    // If order_id provided, verify it belongs to user and has this product
    if (order_id) {
      const orderCheck = await db.query(
        `SELECT 1 FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         WHERE o.id = $1 AND o.user_id = $2 AND oi.product_id = $3 AND o.status = 'delivered'`,
        [order_id, userId, product_id]
      );

      if (orderCheck.rows.length === 0) {
        return sendError(res, 400, 'Invalid order or order not delivered');
      }
    }

    // Use a transaction to create review and optional media rows atomically
    const result = await db.transaction(async (client) => {
      const reviewRes = await client.query(
        `INSERT INTO reviews (product_id, user_id, order_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, product_id, user_id, order_id, rating, comment AS body, created_at AS "createdAt"`,
        [product_id, userId, order_id || null, rating, body]
      );

      const created = reviewRes.rows[0];

      // Only insert media rows when media array exists and has items
      if (media && Array.isArray(media) && media.length > 0) {
        // Limit to 5 items maximum
        const toInsert = media.slice(0, 5);
        for (const item of toInsert) {
          // Support either simple URL strings or objects with { data, type } from the frontend
          let mediaUrl = null;
          let mediaType = 'image';

          if (typeof item === 'string') {
            mediaUrl = item;
          } else if (item && typeof item === 'object') {
            if (item.data) mediaUrl = item.data;
            if (item.type) mediaType = item.type.startsWith('image/') ? 'image' : 'video';
          }

          if (mediaUrl) {
            await client.query(
              `INSERT INTO review_media (review_id, media_type, media_url)
               VALUES ($1, $2, $3)`,
              [created.id, mediaType, mediaUrl]
            );
          }
        }
      }

      return created;
    });

    console.log(`✅ Review created by user ${userId} for product ${product_id}`);

    return sendSuccess(res, 201, 'Review created successfully', {
      review: result
    });
  } catch (error) {
    console.error('Create review error:', error);
    return sendError(res, 500, 'Error creating review', error);
  }
};

/**
 * @desc    Update a review
 * @route   PUT /api/reviews/:id
 * @access  Private
 */
const updateReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviewId = req.params.id;
    const { rating, body } = req.body;

    // Validate input
    if (!rating && !body) {
      return sendError(res, 400, 'Rating or body is required');
    }

    if (rating && (rating < 1 || rating > 5)) {
      return sendError(res, 400, 'Rating must be between 1 and 5');
    }

    if (body && (body.length < 4 || body.length > 1200)) {
      return sendError(res, 400, 'Review must be between 4 and 1200 characters');
    }

    // Check if review exists and belongs to user
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [reviewId, userId]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found or you do not have permission to edit it');
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (rating) {
      updates.push(`rating = $${paramCount}`);
      values.push(rating);
      paramCount++;
    }

    if (body) {
      updates.push(`comment = $${paramCount}`);
      values.push(body);
      paramCount++;
    }

    values.push(reviewId);

    const result = await db.query(
      `UPDATE reviews 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount}
       RETURNING id, rating, comment AS body, updated_at AS "updatedAt"`,
      values
    );

    console.log(`✅ Review ${reviewId} updated by user ${userId}`);

    return sendSuccess(res, 200, 'Review updated successfully', {
      review: result.rows[0]
    });
  } catch (error) {
    console.error('Update review error:', error);
    return sendError(res, 500, 'Error updating review', error);
  }
};

/**
 * @desc    Delete a review (soft delete)
 * @route   DELETE /api/reviews/:id
 * @access  Private
 */
const deleteReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviewId = req.params.id;

    // Check if review exists and belongs to user
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [reviewId, userId]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found or you do not have permission to delete it');
    }

    // Soft delete
    await db.query(
      'UPDATE reviews SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1',
      [reviewId]
    );

    console.log(`✅ Review ${reviewId} deleted by user ${userId}`);

    return sendSuccess(res, 200, 'Review deleted successfully');
  } catch (error) {
    console.error('Delete review error:', error);
    return sendError(res, 500, 'Error deleting review', error);
  }
};

/**
 * @desc    Get reviews for a specific product
 * @route   GET /api/reviews/product/:productId
 * @access  Public
 */
const getProductReviews = async (req, res) => {
  try {
    const productId = req.params.productId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const rating = req.query.rating ? parseInt(req.query.rating) : null;

    // Build WHERE clause
    let whereClause = 'r.product_id = $1 AND r.is_deleted = FALSE AND r.is_approved = TRUE';
    const queryParams = [productId];
    let paramCount = 2;

    if (rating && rating >= 1 && rating <= 5) {
      whereClause += ` AND r.rating = $${paramCount}`;
      queryParams.push(rating);
      paramCount++;
    }

    // Get reviews
    const result = await db.query(
      `SELECT 
        r.id,
        r.rating,
        r.comment AS body,
        r.created_at AS "createdAt",
        u.first_name AS "firstName",
        u.last_name AS "lastName",
        CASE WHEN r.order_id IS NOT NULL THEN true ELSE false END AS "verifiedPurchase",
        (SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = r.id AND vote_type = 'helpful') AS "helpfulCount",
        (SELECT json_agg(
          json_build_object(
              'type', rm.media_type,
              'url', rm.media_url
            )
        ) FROM review_media rm WHERE rm.review_id = r.id) AS media,
        (SELECT json_agg(
          json_build_object(
            'text', rr.reply_text,
            'createdAt', rr.created_at
          )
        ) FROM review_replies rr WHERE rr.review_id = r.id) AS replies
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      WHERE ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...queryParams, limit, offset]
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM reviews r WHERE ${whereClause}`,
      queryParams
    );

    // Get rating summary
    const summaryResult = await db.query(
      `SELECT 
        AVG(rating)::numeric(10,1) as "averageRating",
        COUNT(*) as "totalReviews",
        COUNT(*) FILTER (WHERE rating = 5) as "fiveStar",
        COUNT(*) FILTER (WHERE rating = 4) as "fourStar",
        COUNT(*) FILTER (WHERE rating = 3) as "threeStar",
        COUNT(*) FILTER (WHERE rating = 2) as "twoStar",
        COUNT(*) FILTER (WHERE rating = 1) as "oneStar"
      FROM reviews
      WHERE product_id = $1 AND is_deleted = FALSE AND is_approved = TRUE`,
      [productId]
    );

    return sendSuccess(res, 200, 'Product reviews fetched successfully', {
      reviews: result.rows,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(countResult.rows[0].total / limit),
        totalReviews: parseInt(countResult.rows[0].total),
        limit
      },
      summary: summaryResult.rows[0]
    });
  } catch (error) {
    console.error('Get product reviews error:', error);
    return sendError(res, 500, 'Error fetching product reviews', error);
  }
};

/**
 * @desc    Vote review as helpful/not helpful
 * @route   POST /api/reviews/:id/vote
 * @access  Private
 */
const voteReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviewId = req.params.id;
    const { voteType } = req.body;

    if (!voteType || !['helpful', 'not_helpful'].includes(voteType)) {
      return sendError(res, 400, 'Valid vote type is required (helpful or not_helpful)');
    }

    // Check if review exists
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND is_deleted = FALSE',
      [reviewId]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found');
    }

    // Check if user already voted
    const existingVote = await db.query(
      'SELECT id, vote_type FROM review_helpful_votes WHERE review_id = $1 AND user_id = $2',
      [reviewId, userId]
    );

    if (existingVote.rows.length > 0) {
      // Update existing vote
      await db.query(
        'UPDATE review_helpful_votes SET vote_type = $1 WHERE review_id = $2 AND user_id = $3',
        [voteType, reviewId, userId]
      );
    } else {
      // Create new vote
      await db.query(
        'INSERT INTO review_helpful_votes (review_id, user_id, vote_type) VALUES ($1, $2, $3)',
        [reviewId, userId, voteType]
      );
    }

    // Get updated count
    const countResult = await db.query(
      "SELECT COUNT(*) as count FROM review_helpful_votes WHERE review_id = $1 AND vote_type = 'helpful'",
      [reviewId]
    );

    return sendSuccess(res, 200, 'Vote recorded successfully', {
      helpfulCount: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Vote review error:', error);
    return sendError(res, 500, 'Error recording vote', error);
  }
};

/**
 * @desc    Report a review
 * @route   POST /api/reviews/:id/report
 * @access  Private
 */
const reportReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviewId = req.params.id;
    const { reason, details } = req.body;

    const validReasons = ['spam', 'offensive', 'misleading', 'other'];
    if (!reason || !validReasons.includes(reason)) {
      return sendError(res, 400, 'Valid reason is required');
    }

    // Check if review exists
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND is_deleted = FALSE',
      [reviewId]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found');
    }

    // Check if user already reported this review
    const existingReport = await db.query(
      'SELECT id FROM review_reports WHERE review_id = $1 AND reporter_id = $2',
      [reviewId, userId]
    );

    if (existingReport.rows.length > 0) {
      return sendError(res, 409, 'You have already reported this review');
    }

    // Create report
    await db.query(
      'INSERT INTO review_reports (review_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4)',
      [reviewId, userId, reason, details || null]
    );

    console.log(`✅ Review ${reviewId} reported by user ${userId}`);

    return sendSuccess(res, 201, 'Review reported successfully');
  } catch (error) {
    console.error('Report review error:', error);
    return sendError(res, 500, 'Error reporting review', error);
  }
};

module.exports = {
  getMyReviews,
  createReview,
  updateReview,
  deleteReview,
  getProductReviews,
  voteReview,
  reportReview
};