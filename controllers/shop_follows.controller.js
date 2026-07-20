const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

async function resolveStore(idParam) {
  const byStore = await db.query(
    `SELECT id, user_id FROM stores WHERE id = $1 AND is_deleted = false`,
    [idParam]
  );
  if (byStore.rows.length) return byStore.rows[0];

  const bySeller = await db.query(
    `SELECT id, user_id FROM stores WHERE user_id = $1 AND is_deleted = false ORDER BY store_number ASC LIMIT 1`,
    [idParam]
  );
  return bySeller.rows[0] || null;
}

const followShop = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const store = await resolveStore(req.params.sellerId);
    if (!store) return sendError(res, 404, 'Store not found');
    if (buyerId === store.user_id) return sendError(res, 400, 'Cannot follow yourself');

    await db.query(
      `INSERT INTO shop_follows (buyer_id, seller_id, store_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (buyer_id, store_id) DO NOTHING`,
      [buyerId, store.user_id, store.id]
    );

    return sendSuccess(res, 200, 'Shop followed');
  } catch (err) {
    console.error('followShop error:', err);
    return sendError(res, 500, 'Error following shop');
  }
};

const unfollowShop = async (req, res) => {
  try {
    const store = await resolveStore(req.params.sellerId);
    if (store) {
      await db.query(
        'DELETE FROM shop_follows WHERE buyer_id = $1 AND store_id = $2',
        [req.user.id, store.id]
      );
    }

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
         st.id AS store_id,
         st.user_id AS seller_id,
         st.business_name,
         st.store_logo_url AS store_logo,
         st.rating,
         st.is_verified,
         st.category,
         (SELECT main_image_url FROM products p
          WHERE p.store_id = st.id AND p.is_active = true AND p.is_deleted = false
          ORDER BY p.created_at DESC LIMIT 1) AS featured_product_image,
         (SELECT COUNT(*) FROM products p
          WHERE p.store_id = st.id AND p.is_active = true AND p.is_deleted = false) AS product_count,
         sf.created_at AS followed_at
       FROM shop_follows sf
       JOIN stores st ON st.id = sf.store_id
       WHERE sf.buyer_id = $1 AND st.is_deleted = false
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
    const store = await resolveStore(req.params.sellerId);
    if (!store) return sendSuccess(res, 200, 'Follow status', { isFollowing: false });

    const result = await db.query(
      'SELECT 1 FROM shop_follows WHERE buyer_id = $1 AND store_id = $2',
      [buyerId, store.id]
    );

    return sendSuccess(res, 200, 'Follow status', { isFollowing: result.rows.length > 0 });
  } catch (err) {
    return sendError(res, 500, 'Error checking follow status');
  }
};

module.exports = { followShop, unfollowShop, getFollowedShops, checkFollowStatus };