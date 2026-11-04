const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { notifySeller } = require('../utils/sellerEmailService');
const { uploadReviewMedia, deleteReviewMedia } = require('../utils/cloudinary');
const { createDedupedNotification } = require('./notification.controller');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVIEW_MEDIA_FILES = 5;
const MAX_REVIEW_MEDIA_BYTES = 10 * 1024 * 1024;

const getReviewMediaType = (file) => {
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  const buffer = file.buffer;
  if (!buffer || buffer.length > MAX_REVIEW_MEDIA_BYTES) return null;

  if (file.mimetype === 'image/jpeg' && ['jpg', 'jpeg'].includes(extension) &&
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image';
  if (file.mimetype === 'image/png' && extension === 'png' &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image';
  if (file.mimetype === 'image/gif' && extension === 'gif' &&
      ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image';
  if (file.mimetype === 'image/webp' && extension === 'webp' &&
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image';
  if (file.mimetype === 'video/mp4' && extension === 'mp4' &&
      buffer.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (file.mimetype === 'video/quicktime' && extension === 'mov' &&
      buffer.toString('ascii', 4, 8) === 'ftyp' && buffer.toString('ascii', 8, 12) === 'qt  ') return 'video';
  if (file.mimetype === 'video/webm' && extension === 'webm' &&
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video';
  return null;
};

const getVerifiedSellerStoreId = async (req, res) => {
  const storeId = req.headers['x-store-id'];
  if (typeof storeId !== 'string' || !UUID_PATTERN.test(storeId)) {
    sendError(res, 400, 'A valid active store is required. Select a store you own and try again.');
    return null;
  }

  const result = await db.query(
    'SELECT id FROM stores WHERE id = $1 AND user_id = $2 AND is_deleted = false AND is_active = true',
    [storeId, req.user.id]
  );
  if (result.rows.length === 0) {
    sendError(res, 400, 'A valid active store is required. Select a store you own and try again.');
    return null;
  }

  return storeId;
};

/**
 * @desc    Get visible reviews for the authenticated seller's active store
 * @route   GET /api/reviews/seller/my-reviews
 * @access  Private (Seller)
 */
const getSellerStoreReviews = async (req, res) => {
  try {
    const storeId = await getVerifiedSellerStoreId(req, res);
    if (!storeId) return;

    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    if (!Number.isInteger(page) || page < 1 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return sendError(res, 400, 'Page must be a positive integer and limit must be between 1 and 100');
    }

    const offset = (page - 1) * limit;
    const reviewFilter = `
      p.seller_id = $1
      AND p.store_id = $2
      AND p.is_deleted = false
      AND r.is_approved = true
      AND r.is_deleted = false
      AND r.moderation_status = 'published'`;
    const [reviewsResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           r.id,
           r.product_id AS "productId",
           p.name AS "productName",
           p.main_image_url AS "productImage",
           r.rating,
           r.comment,
           r.created_at AS "createdAt",
           NULLIF(TRIM(CONCAT_WS(' ', NULLIF(u.first_name, ''), NULLIF(u.last_name, ''))), '') AS "buyerName",
           COALESCE((
             SELECT json_agg(
               json_build_object(
                 'id', rm.id,
                 'type', rm.media_type,
                 'url', rm.media_url,
                 'thumbnailUrl', rm.thumbnail_url
               ) ORDER BY rm.created_at, rm.id
             )
             FROM review_media rm
             WHERE rm.review_id = r.id
           ), '[]'::json) AS media,
           COALESCE((
             SELECT json_agg(
               json_build_object(
                 'id', rr.id,
                 'text', rr.reply_text,
                 'createdAt', rr.created_at,
                 'updatedAt', rr.updated_at
               ) ORDER BY rr.created_at, rr.id
             )
             FROM review_replies rr
             WHERE rr.review_id = r.id AND rr.seller_id = $1
           ), '[]'::json) AS replies
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         JOIN users u ON u.id = r.user_id
         WHERE ${reviewFilter}
         ORDER BY r.created_at DESC, r.id
         LIMIT $3 OFFSET $4`,
        [req.user.id, storeId, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) AS total
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         WHERE ${reviewFilter}`,
        [req.user.id, storeId]
      )
    ]);

    const total = Number(countResult.rows[0].total);
    return sendSuccess(res, 200, 'Seller reviews fetched successfully', {
      reviews: reviewsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get seller store reviews error:', error);
    return sendError(res, 500, 'Error fetching seller reviews', error);
  }
};

/**
 * @desc    Create a reply to a visible review for the authenticated seller
 * @route   POST /api/reviews/seller/my-reviews/:reviewId/replies
 * @access  Private (Seller)
 * @body    { reply_text }
 */
const createSellerReviewReply = async (req, res) => {
  try {
    const storeId = await getVerifiedSellerStoreId(req, res);
    if (!storeId) return;

    const { reviewId } = req.params;
    if (!UUID_PATTERN.test(reviewId)) {
      return sendError(res, 400, 'A valid review ID is required');
    }

    const replyText = typeof req.body?.reply_text === 'string' ? req.body.reply_text.trim() : '';
    const replyLength = Array.from(replyText).length;
    if (replyLength < 1 || replyLength > 500) {
      return sendError(res, 400, 'Reply text must be between 1 and 500 characters');
    }

    const result = await db.transaction(async (client) => {
      const reviewResult = await client.query(
        `SELECT r.id, r.user_id AS "buyerId", p.name AS "productName"
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         WHERE r.id = $1
           AND p.seller_id = $2
           AND p.store_id = $3
           AND p.is_deleted = false
           AND r.is_approved = true
           AND r.is_deleted = false
           AND r.moderation_status = 'published'
         FOR UPDATE OF r`,
        [reviewId, req.user.id, storeId]
      );
      if (reviewResult.rows.length === 0) return { notFound: true };

      const duplicateResult = await client.query(
        `SELECT id, review_id AS "reviewId", reply_text AS text,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM review_replies
         WHERE review_id = $1
           AND seller_id = $2
           AND reply_text = $3
           AND created_at >= NOW() - INTERVAL '10 seconds'
         ORDER BY created_at DESC
         LIMIT 1`,
        [reviewId, req.user.id, replyText]
      );
      if (duplicateResult.rows.length > 0) {
        return { reply: duplicateResult.rows[0], duplicate: true };
      }

      const replyResult = await client.query(
        `INSERT INTO review_replies (review_id, seller_id, reply_text)
         VALUES ($1, $2, $3)
         RETURNING id, review_id AS "reviewId", reply_text AS text,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [reviewId, req.user.id, replyText]
      );
      return { reply: replyResult.rows[0], duplicate: false, buyerId: reviewResult.rows[0]?.buyerId, productName: reviewResult.rows[0]?.productName };
    });

    if (result.notFound) {
      return sendError(res, 404, 'Review not found for the selected store');
    }

    if (!result.duplicate && result.buyerId) {
      await createDedupedNotification({
        userId: result.buyerId,
        title: 'Seller replied to your review',
        message: `Your review for ${result.productName || 'this product'} has a new seller response.`,
        type: 'review',
        link: '/buyers/reviews%20ratings.html',
        referenceId: result.reply.id
      });
    }

    return sendSuccess(
      res,
      result.duplicate ? 200 : 201,
      result.duplicate ? 'Reply already submitted' : 'Reply created successfully',
      { reply: result.reply }
    );
  } catch (error) {
    console.error('Create seller review reply error:', error);
    return sendError(res, 500, 'Error creating review reply', error);
  }
};

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
        to_jsonb(r)->>'moderation_status' AS "moderationStatus",
        COALESCE(p.name, 'Product') AS "productName",
        CASE WHEN r.order_id IS NOT NULL THEN true ELSE false END AS "verifiedPurchase",
        (SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = r.id AND vote_type = 'helpful') AS "helpfulCount",
        (SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = r.id AND vote_type = 'not_helpful') AS "notHelpfulCount",
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
      WHERE r.user_id = $1
        AND (r.is_deleted = FALSE OR to_jsonb(r)->>'moderation_status' = 'removed')
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
    const { product_id, order_id, rating, body } = req.body;
    const files = Array.isArray(req.files) ? req.files : [];

    // Validate required fields
    if (!product_id || !rating || typeof body !== 'string') {
      return sendError(res, 400, 'Product ID, rating, and review body are required');
    }

    // Validate rating
    if (rating < 1 || rating > 5) {
      return sendError(res, 400, 'Rating must be between 1 and 5');
    }

    // Validate body length
    if (body.trim().length < 4 || body.length > 1200) {
      return sendError(res, 400, 'Review must be between 4 and 1200 characters');
    }

    if (files.length > MAX_REVIEW_MEDIA_FILES) {
      return sendError(res, 400, `A maximum of ${MAX_REVIEW_MEDIA_FILES} review media files is allowed`);
    }

    const mediaTypes = files.map(getReviewMediaType);
    if (mediaTypes.some((mediaType) => !mediaType)) {
      return sendError(res, 400, 'Each review attachment must be a supported image or video file with a valid file signature');
    }

    // Check if product exists
    const productCheck = await db.query(
      'SELECT id FROM products WHERE id = $1',
      [product_id]
    );

    if (productCheck.rows.length === 0) {
      return sendError(res, 404, 'Product not found');
    }

    if (!order_id) {
      return sendError(res, 400, 'A delivered order containing this product is required');
    }

    // Check if user already reviewed this product
    const existingReview = await db.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [product_id, userId]
    );

    if (existingReview.rows.length > 0) {
      return sendError(res, 409, 'You have already reviewed this product');
    }

    // Verify the authenticated buyer owns the delivered order and bought this product.
    const orderCheck = await db.query(
      `SELECT 1 FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       WHERE o.id = $1 AND o.buyer_id = $2 AND oi.product_id = $3 AND o.status = 'delivered'`,
      [order_id, userId, product_id]
    );

    if (orderCheck.rows.length === 0) {
      return sendError(res, 400, 'Invalid order or order not delivered');
    }

    const uploadedMedia = [];
    let result;
    try {
      for (let index = 0; index < files.length; index += 1) {
        uploadedMedia.push(await uploadReviewMedia(files[index].buffer, mediaTypes[index], userId));
      }

      result = await db.transaction(async (client) => {
        const reviewRes = await client.query(
          `INSERT INTO reviews (product_id, user_id, order_id, rating, comment)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, product_id, user_id, order_id, rating, comment AS body, created_at AS "createdAt"`,
          [product_id, userId, order_id, rating, body.trim()]
        );

        const created = reviewRes.rows[0];
        for (let index = 0; index < uploadedMedia.length; index += 1) {
          await client.query(
            `INSERT INTO review_media (review_id, media_type, media_url)
             VALUES ($1, $2, $3)`,
            [created.id, mediaTypes[index], uploadedMedia[index].url]
          );
        }

        return created;
      });
    } catch (error) {
      const cleanupResults = await Promise.allSettled(uploadedMedia.map(deleteReviewMedia));
      cleanupResults.forEach((cleanupResult) => {
        if (cleanupResult.status === 'rejected') {
          console.error('Failed to clean up an unassociated review media upload:', cleanupResult.reason);
        }
      });
      throw error;
    }

    console.log(`✅ Review created by user ${userId} for product ${product_id}`);

    const prod = await db.query('SELECT seller_id, name FROM products WHERE id=$1', [product_id]);
    if (prod.rows.length) {
      try {
        await createDedupedNotification({
          userId: prod.rows[0].seller_id,
          title: 'New product review',
          message: `A buyer left a ${rating}-star review on ${prod.rows[0].name || 'your product'}.`,
          type: 'review',
          link: '/sellers/seller-reviews.html',
          referenceId: result.id
        });
      } catch (notificationError) {
        console.error('Failed to create seller review notification:', notificationError);
      }

      notifySeller(prod.rows[0].seller_id, 'newReview', {
        productName: prod.rows[0].name,
        rating, comment: body,
        reviewerName: 'A buyer'
      }).catch(err => console.error('EMAIL FAIL:', err));
    }

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
    let whereClause = `r.product_id = $1
      AND r.is_deleted = FALSE
      AND r.is_approved = TRUE
      AND to_jsonb(r)->>'moderation_status' = 'published'`;
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
        (SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = r.id AND vote_type = 'not_helpful') AS "notHelpfulCount",
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
      WHERE product_id = $1
        AND is_deleted = FALSE
        AND is_approved = TRUE
        AND to_jsonb(reviews)->>'moderation_status' = 'published'`,
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
      `SELECT
         COUNT(*) FILTER (WHERE vote_type = 'helpful') AS "helpfulCount",
         COUNT(*) FILTER (WHERE vote_type = 'not_helpful') AS "notHelpfulCount"
       FROM review_helpful_votes
       WHERE review_id = $1`,
      [reviewId]
    );

    return sendSuccess(res, 200, 'Vote recorded successfully', {
      helpfulCount: parseInt(countResult.rows[0].helpfulCount),
      notHelpfulCount: parseInt(countResult.rows[0].notHelpfulCount)
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
  reportReview,
  getSellerStoreReviews,
  createSellerReviewReply
};
