const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

const followShop = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { sellerId } = req.params;

    const sellerCheck = await db.query(
      `SELECT u.id FROM users u
       JOIN seller_profiles sp ON sp.user_id = u.id
       WHERE u.id = $1 AND u.is_deleted = false`,
      [sellerId]
    );
    if (!sellerCheck.rows.length) return sendError(res, 404, 'Seller not found');
    if (buyerId === sellerId) return sendError(res, 400, 'Cannot follow yourself');

    await db.query(
      `INSERT INTO shop_follows (buyer_id, seller_id)
       VALUES ($1, $2)
       ON CONFLICT (buyer_id, seller_id) DO NOTHING`,
      [buyerId, sellerId]
    );

    return sendSuccess(res, 200, 'Shop followed');
  } catch (err) {
    console.error('followShop error:', err);
    return sendError(res, 500, 'Error following shop');
  }
};

const unfollowShop = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { sellerId } = req.params;

    await db.query(
      'DELETE FROM shop_follows WHERE buyer_id = $1 AND seller_id = $2',
      [buyerId, sellerId]
    );

    return sendSuccess(res, 200, 'Shop unfollowed');
  } catch (err) {
    console.error('unfollowShop error:', err);
    return sendError(res, 500, 'Error unfollowing shop');
  }
};

const getFollowedShops = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await db.query(
      `SELECT
         u.id AS seller_id,
         COALESCE(sp.business_name, u.first_name || ' ' || u.last_name) AS business_name,
         sp.store_logo_url AS store_logo,
         sp.rating,
         sp.is_verified,
         sp.kyc_document_urls->>'category' AS category,
         (SELECT main_image_url FROM products p
          WHERE p.seller_id = u.id AND p.is_active = true AND p.is_deleted = false
          ORDER BY p.created_at DESC LIMIT 1) AS featured_product_image,
         (SELECT COUNT(*) FROM products p
          WHERE p.seller_id = u.id AND p.is_active = true AND p.is_deleted = false) AS product_count,
         sf.created_at AS followed_at
       FROM shop_follows sf
       JOIN users u ON u.id = sf.seller_id
       JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false
       WHERE sf.buyer_id = $1
       ORDER BY sf.created_at DESC
       LIMIT $2 OFFSET $3`,
      [buyerId, parseInt(limit), offset]
    );

    const countRes = await db.query(
      'SELECT COUNT(*) FROM shop_follows WHERE buyer_id = $1',
      [buyerId]
    );

    return sendSuccess(res, 200, 'Followed shops fetched', {
      shops: result.rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('getFollowedShops error:', err);
    return sendError(res, 500, 'Error fetching followed shops');
  }
};

const checkFollowStatus = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const { sellerId } = req.params;

    const result = await db.query(
      'SELECT 1 FROM shop_follows WHERE buyer_id = $1 AND seller_id = $2',
      [buyerId, sellerId]
    );

    return sendSuccess(res, 200, 'Follow status', { isFollowing: result.rows.length > 0 });
  } catch (err) {
    return sendError(res, 500, 'Error checking follow status');
  }
};

module.exports = { followShop, unfollowShop, getFollowedShops, checkFollowStatus };