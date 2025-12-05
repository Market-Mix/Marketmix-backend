const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Create a new review (product or seller)
 * @route   POST /api/reviews
 * @access  Private
 */
const createReview = async (req, res) => {
  try {
    const {
      review_type,
      product_id,
      seller_id,
      rating,
      title,
      body,
      order_id,
      media
    } = req.body;

    const reviewer_id = req.user.id;

    // Validation
    if (!review_type || !['product', 'seller'].includes(review_type)) {
      return sendError(res, 400, 'Invalid review_type. Must be "product" or "seller"');
    }

    if (review_type === 'product' && !product_id) {
      return sendError(res, 400, 'product_id is required for product reviews');
    }

    if (review_type === 'seller' && !seller_id) {
      return sendError(res, 400, 'seller_id is required for seller reviews');
    }

    if (!rating || rating < 1 || rating > 5) {
      return sendError(res, 400, 'Rating must be between 1 and 5');
    }

    if (!body || body.length < 4 || body.length > 1200) {
      return sendError(res, 400, 'Review body must be between 4 and 1200 characters');
    }

    // Check if user already reviewed this product/seller
    const existingReview = await db.query(
      `SELECT id FROM reviews 
       WHERE reviewer_id = $1 AND review_type = $2 
       AND ${review_type === 'product' ? 'product_id' : 'seller_id'} = $3 
       AND is_deleted = FALSE`,
      [reviewer_id, review_type, review_type === 'product' ? product_id : seller_id]
    );

    if (existingReview.rows.length > 0) {
      return sendError(res, 400, `You have already reviewed this ${review_type}`);
    }

    // Verify purchase if order_id provided
    let verified_purchase = false;
    if (order_id) {
      const orderCheck = await db.query(
        `SELECT o.id FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         WHERE o.id = $1 AND o.user_id = $2 ${review_type === 'product' ? 'AND oi.product_id = $3' : ''}
         AND o.status IN ('delivered', 'completed')`,
        review_type === 'product' ? [order_id, reviewer_id, product_id] : [order_id, reviewer_id]
      );

      verified_purchase = orderCheck.rows.length > 0;
    }

    // Insert review
    const reviewResult = await db.query(
      `INSERT INTO reviews (
        reviewer_id, review_type, product_id, seller_id, 
        rating, title, body, order_id, verified_purchase, 
        status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, rating, title, body, verified_purchase, created_at`,
      [
        reviewer_id,
        review_type,
        review_type === 'product' ? product_id : null,
        review_type === 'seller' ? seller_id : null,
        rating,
        title || null,
        body,
        order_id || null,
        verified_purchase,
        'published'
      ]
    );

    const review = reviewResult.rows[0];

    // Insert media if provided (base64 data URLs stored temporarily)
    if (media && Array.isArray(media) && media.length > 0) {
      for (const m of media.slice(0, 3)) { // Max 3 media files
        await db.query(
          `INSERT INTO review_media (review_id, media_type, media_url, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [review.id, m.type.startsWith('image') ? 'image' : 'video', m.data]
        );
      }
    }

    console.log(`✅ Review created: ID ${review.id} by user ${reviewer_id}`);

    return sendSuccess(res, 201, 'Review created successfully', {
      review: {
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        verifiedPurchase: review.verified_purchase,
        createdAt: review.created_at
      }
    });

  } catch (error) {
    console.error('❌ Create review error:', error);
    return sendError(res, 500, 'Error creating review', error);
  }
};

/**
 * @desc    Get reviews for a product
 * @route   GET /api/reviews/product/:productId
 * @access  Public
 */
const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    const { sort = 'newest', rating, page = 1, limit = 10 } = req.query;

    const offset = (page - 1) * limit;

    let orderBy = 'r.created_at DESC';
    if (sort === 'oldest') orderBy = 'r.created_at ASC';
    if (sort === 'highest') orderBy = 'r.rating DESC, r.created_at DESC';
    if (sort === 'lowest') orderBy = 'r.rating ASC, r.created_at DESC';
    if (sort === 'helpful') orderBy = 'r.helpful_count DESC, r.created_at DESC';

    const ratingFilter = rating ? `AND r.rating = ${parseInt(rating)}` : '';

    const result = await db.query(
      `SELECT 
        r.id, r.rating, r.title, r.body, r.verified_purchase, r.helpful_count,
        r.created_at, r.updated_at,
        u.first_name, u.last_name, u.avatar_url,
        COALESCE(
          json_agg(
            json_build_object(
              'id', rm.id,
              'type', rm.media_type,
              'url', rm.media_url
            )
          ) FILTER (WHERE rm.id IS NOT NULL), '[]'
        ) as media,
        COALESCE(
          json_agg(
            json_build_object(
              'id', rr.id,
              'text', rr.reply_text,
              'sellerId', rr.seller_id,
              'createdAt', rr.created_at
            )
          ) FILTER (WHERE rr.id IS NOT NULL), '[]'
        ) as replies
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       LEFT JOIN review_media rm ON r.id = rm.review_id
       LEFT JOIN review_replies rr ON r.id = rr.review_id
       WHERE r.product_id = $1 AND r.status = 'published' AND r.is_deleted = FALSE
       ${ratingFilter}
       GROUP BY r.id, u.first_name, u.last_name, u.avatar_url
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [productId, limit, offset]
    );

    // Get total count and average rating
    const statsResult = await db.query(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as average_rating,
        COUNT(*) FILTER (WHERE rating = 5) as five_star,
        COUNT(*) FILTER (WHERE rating = 4) as four_star,
        COUNT(*) FILTER (WHERE rating = 3) as three_star,
        COUNT(*) FILTER (WHERE rating = 2) as two_star,
        COUNT(*) FILTER (WHERE rating = 1) as one_star
       FROM reviews
       WHERE product_id = $1 AND status = 'published' AND is_deleted = FALSE`,
      [productId]
    );

    const stats = statsResult.rows[0];

    return sendSuccess(res, 200, 'Reviews fetched successfully', {
      reviews: result.rows.map(r => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        verifiedPurchase: r.verified_purchase,
        helpfulCount: r.helpful_count,
        author: {
          firstName: r.first_name,
          lastName: r.last_name,
          avatar: r.avatar_url
        },
        media: r.media,
        replies: r.replies,
        createdAt: r.created_at
      })),
      stats: {
        totalReviews: parseInt(stats.total_reviews),
        averageRating: parseFloat(stats.average_rating || 0).toFixed(1),
        ratingDistribution: {
          5: parseInt(stats.five_star),
          4: parseInt(stats.four_star),
          3: parseInt(stats.three_star),
          2: parseInt(stats.two_star),
          1: parseInt(stats.one_star)
        }
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(parseInt(stats.total_reviews) / limit),
        totalItems: parseInt(stats.total_reviews)
      }
    });

  } catch (error) {
    console.error('❌ Get product reviews error:', error);
    return sendError(res, 500, 'Error fetching reviews', error);
  }
};

/**
 * @desc    Get user's reviews
 * @route   GET /api/reviews/my-reviews
 * @access  Private
 */
const getMyReviews = async (req, res) => {
  try {
    const reviewer_id = req.user.id;

    const result = await db.query(
      `SELECT 
        r.id, r.review_type, r.product_id, r.seller_id, r.rating, r.title, r.body,
        r.verified_purchase, r.helpful_count, r.status, r.created_at, r.updated_at,
        p.name as product_name, p.main_image_url as product_image,
        COALESCE(
          json_agg(
            json_build_object(
              'id', rm.id,
              'type', rm.media_type,
              'url', rm.media_url
            )
          ) FILTER (WHERE rm.id IS NOT NULL), '[]'
        ) as media,
        COALESCE(
          json_agg(
            json_build_object(
              'id', rr.id,
              'text', rr.reply_text,
              'createdAt', rr.created_at
            )
          ) FILTER (WHERE rr.id IS NOT NULL), '[]'
        ) as replies
       FROM reviews r
       LEFT JOIN products p ON r.product_id = p.id
       LEFT JOIN review_media rm ON r.id = rm.review_id
       LEFT JOIN review_replies rr ON r.id = rr.review_id
       WHERE r.reviewer_id = $1 AND r.is_deleted = FALSE
       GROUP BY r.id, p.name, p.main_image_url
       ORDER BY r.created_at DESC`,
      [reviewer_id]
    );

    return sendSuccess(res, 200, 'Your reviews fetched successfully', {
      reviews: result.rows.map(r => ({
        id: r.id,
        type: r.review_type,
        productId: r.product_id,
        productName: r.product_name,
        productImage: r.product_image,
        rating: r.rating,
        title: r.title,
        body: r.body,
        verifiedPurchase: r.verified_purchase,
        helpfulCount: r.helpful_count,
        status: r.status,
        media: r.media,
        replies: r.replies,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });

  } catch (error) {
    console.error('❌ Get my reviews error:', error);
    return sendError(res, 500, 'Error fetching reviews', error);
  }
};

/**
 * @desc    Update a review
 * @route   PUT /api/reviews/:reviewId
 * @access  Private
 */
const updateReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { rating, title, body } = req.body;
    const reviewer_id = req.user.id;

    // Check if review exists and belongs to user
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND reviewer_id = $2 AND is_deleted = FALSE',
      [reviewId, reviewer_id]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found or you do not have permission to edit it');
    }

    // Validation
    if (rating && (rating < 1 || rating > 5)) {
      return sendError(res, 400, 'Rating must be between 1 and 5');
    }

    if (body && (body.length < 4 || body.length > 1200)) {
      return sendError(res, 400, 'Review body must be between 4 and 1200 characters');
    }

    // Build update query dynamically
    const fields = [];
    const values = [];
    let idx = 1;

    if (rating !== undefined) {
      fields.push(`rating = $${idx++}`);
      values.push(rating);
    }
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (body !== undefined) {
      fields.push(`body = $${idx++}`);
      values.push(body);
    }

    if (fields.length === 0) {
      return sendError(res, 400, 'No fields to update');
    }

    values.push(reviewId);

    const result = await db.query(
      `UPDATE reviews SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING id, rating, title, body, updated_at`,
      values
    );

    console.log(`✅ Review updated: ID ${reviewId}`);

    return sendSuccess(res, 200, 'Review updated successfully', {
      review: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update review error:', error);
    return sendError(res, 500, 'Error updating review', error);
  }
};

/**
 * @desc    Delete a review
 * @route   DELETE /api/reviews/:reviewId
 * @access  Private
 */
const deleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const reviewer_id = req.user.id;

    const result = await db.query(
      'UPDATE reviews SET is_deleted = TRUE, status = $1, updated_at = NOW() WHERE id = $2 AND reviewer_id = $3 RETURNING id',
      ['deleted', reviewId, reviewer_id]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Review not found or you do not have permission to delete it');
    }

    console.log(`✅ Review deleted: ID ${reviewId}`);

    return sendSuccess(res, 200, 'Review deleted successfully');

  } catch (error) {
    console.error('❌ Delete review error:', error);
    return sendError(res, 500, 'Error deleting review', error);
  }
};

/**
 * @desc    Add seller reply to a review
 * @route   POST /api/reviews/:reviewId/reply
 * @access  Private (Seller only)
 */
const addReply = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { reply_text } = req.body;
    const seller_id = req.user.id;

    if (!reply_text || reply_text.length < 1 || reply_text.length > 500) {
      return sendError(res, 400, 'Reply must be between 1 and 500 characters');
    }

    // Check if review exists
    const reviewCheck = await db.query(
      'SELECT id FROM reviews WHERE id = $1 AND is_deleted = FALSE',
      [reviewId]
    );

    if (reviewCheck.rows.length === 0) {
      return sendError(res, 404, 'Review not found');
    }

    // Insert reply
    const result = await db.query(
      `INSERT INTO review_replies (review_id, seller_id, reply_text, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, reply_text, created_at`,
      [reviewId, seller_id, reply_text]
    );

    console.log(`✅ Reply added to review ${reviewId} by seller ${seller_id}`);

    return sendSuccess(res, 201, 'Reply added successfully', {
      reply: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Add reply error:', error);
    return sendError(res, 500, 'Error adding reply', error);
  }
};

/**
 * @desc    Mark review as helpful/not helpful
 * @route   POST /api/reviews/:reviewId/vote
 * @access  Private
 */
const voteHelpful = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { vote_type } = req.body;
    const user_id = req.user.id;

    if (!vote_type || !['helpful', 'not_helpful'].includes(vote_type)) {
      return sendError(res, 400, 'vote_type must be "helpful" or "not_helpful"');
    }

    // Check if user already voted
    const existingVote = await db.query(
      'SELECT id, vote_type FROM review_helpful_votes WHERE review_id = $1 AND user_id = $2',
      [reviewId, user_id]
    );

    if (existingVote.rows.length > 0) {
      // Update existing vote
      await db.query(
        'UPDATE review_helpful_votes SET vote_type = $1 WHERE id = $2',
        [vote_type, existingVote.rows[0].id]
      );
    } else {
      // Insert new vote
      await db.query(
        'INSERT INTO review_helpful_votes (review_id, user_id, vote_type) VALUES ($1, $2, $3)',
        [reviewId, user_id, vote_type]
      );
    }

    // Update counts
    const counts = await db.query(
      `SELECT 
        COUNT(*) FILTER (WHERE vote_type = 'helpful') as helpful,
        COUNT(*) FILTER (WHERE vote_type = 'not_helpful') as not_helpful
       FROM review_helpful_votes WHERE review_id = $1`,
      [reviewId]
    );

    await db.query(
      'UPDATE reviews SET helpful_count = $1, not_helpful_count = $2 WHERE id = $3',
      [counts.rows[0].helpful, counts.rows[0].not_helpful, reviewId]
    );

    return sendSuccess(res, 200, 'Vote recorded successfully');

  } catch (error) {
    console.error('❌ Vote helpful error:', error);
    return sendError(res, 500, 'Error recording vote', error);
  }
};

module.exports = {
  createReview,
  getProductReviews,
  getMyReviews,
  updateReview,
  deleteReview,
  addReply,
  voteHelpful
};