const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Add item to wishlist
 * POST /api/wishlist/add
 */
const addToWishlist = async (req, res) => {
  try {
    const user_id = req.user.id;
    const { product_id } = req.body;

    if (!user_id) return sendError(res, 401, 'Not authenticated');
    if (!product_id) return sendError(res, 400, 'product_id required');

    // Check if already exists
    const exists = await db.query(
      `SELECT id FROM wishlist_items WHERE user_id = $1 AND product_id = $2 LIMIT 1`,
      [user_id, product_id]
    );

    if (exists.rows.length > 0) {
      return sendSuccess(res, 200, 'Already in wishlist');
    }

    const insert = await db.query(
      `INSERT INTO wishlist_items (user_id, product_id, created_at) VALUES ($1, $2, NOW()) RETURNING id, product_id, created_at`,
      [user_id, product_id]
    );

    return sendSuccess(res, 201, 'Added to wishlist', { item: insert.rows[0] });
  } catch (error) {
    console.error('Wishlist add error:', error);
    return sendError(res, 500, 'Error adding to wishlist');
  }
};

/**
 * Get wishlist for user
 * GET /api/wishlist
 */
const getWishlist = async (req, res) => {
  try {
    const user_id = req.user.id;
    if (!user_id) return sendError(res, 401, 'Not authenticated');

    const result = await db.query(
      `SELECT wi.id, wi.product_id, p.name, p.price, p.main_image_url, wi.created_at
       FROM wishlist_items wi
       JOIN products p ON wi.product_id = p.id
       WHERE wi.user_id = $1
       ORDER BY wi.created_at DESC`,
      [user_id]
    );

    return sendSuccess(res, 200, 'Wishlist retrieved', { items: result.rows });
  } catch (error) {
    console.error('Get wishlist error:', error);
    return sendError(res, 500, 'Error retrieving wishlist');
  }
};

module.exports = { addToWishlist, getWishlist };
