const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { slugify, uniqueAccountSlug } = require('../utils/slugify');

/* ─── helpers ────────────────────────────────────────────────────────────── */

/** Return how many stores this user already has (active, not deleted) */
async function countStores(userId) {
  const r = await db.query(
    `SELECT COUNT(*) FROM stores WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  return parseInt(r.rows[0].count);
}

/** Verify the store belongs to the requesting seller */
async function ownsStore(userId, storeId) {
  const r = await db.query(
    `SELECT id FROM stores WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [storeId, userId]
  );
  return r.rows.length > 0;
}

/* ─── GET /api/seller/stores ─────────────────────────────────────────────── */
/**
 * @desc  List all stores owned by the authenticated seller
 * @route GET /api/seller/stores
 * @access Private (seller)
 */
const getMyStores = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT
         stores.id, stores.store_number, stores.slug,
         stores.business_name, stores.business_description,
         stores.business_address, stores.business_phone, stores.business_email,
         stores.store_logo_url, stores.store_banner_url, stores.store_theme, stores.website,
         stores.facebook, stores.twitter, stores.instagram,
         stores.tiktok, stores.telegram, stores.category,
         stores.is_verified, stores.rating, stores.total_reviews, stores.total_sales,
         stores.total_earnings, stores.available_balance, stores.is_active, stores.created_at,
         u.account_slug,
         (SELECT COUNT(*) FROM products p
          WHERE p.store_id = stores.id
            AND p.is_active = true AND p.is_deleted = false) AS product_count
       FROM stores
       JOIN users u ON u.id = stores.user_id
       WHERE stores.user_id = $1 AND stores.is_deleted = false
       ORDER BY stores.store_number ASC`,
      [userId]
    );

    return sendSuccess(res, 200, 'Stores fetched', {
      stores: result.rows.map(s => ({
        ...s,
        rating:           parseFloat(s.rating)           || 0,
        totalEarnings:    parseFloat(s.total_earnings)    || 0,
        availableBalance: parseFloat(s.available_balance) || 0,
        productCount:     parseInt(s.product_count)       || 0,
      })),
      canCreateMore: result.rows.length < 2,
    });
  } catch (err) {
    console.error('getMyStores error:', err);
    return sendError(res, 500, 'Error fetching stores', err.message);
  }
};

/* ─── POST /api/seller/stores ────────────────────────────────────────────── */
/**
 * @desc  Create a second store (first store created during setup-store flow)
 * @route POST /api/seller/stores
 * @access Private (seller)
 */
const createStore = async (req, res) => {
  try {
    const userId = req.user.id;
    const { storeName, storeDescription, businessEmail, businessPhone,
            businessAddress, website, category, storeLogoUrl,
            facebook, twitter, tiktok, instagram, telegram } = req.body;

    if (!storeName) return sendError(res, 400, 'Store name is required');

    const userRow = await db.query('SELECT first_name, account_slug FROM users WHERE id = $1', [userId]);
    let accountSlug = userRow.rows[0]?.account_slug;
    if (!accountSlug) {
      accountSlug = await uniqueAccountSlug(db, userRow.rows[0]?.first_name || 'seller');
      await db.query('UPDATE users SET account_slug = $1 WHERE id = $2', [accountSlug, userId]);
    }

    const storeSlug = slugify(storeName);

    const count = await countStores(userId);
    if (count >= 2) {
      return sendError(res, 400, 'You can only have 2 stores per account');
    }

    // KYC must be verified on account before creating a second store
    const kycRes = await db.query(
      `SELECT is_verified FROM seller_profiles WHERE user_id = $1 AND is_deleted = false`,
      [userId]
    );
    if (!kycRes.rows.length || !kycRes.rows[0].is_verified) {
      return sendError(res, 403, 'Complete KYC verification before creating a second store');
    }

    const storeNumber = count + 1; // will be 2

    const result = await db.query(
      `INSERT INTO stores (
         user_id, store_number, slug, business_name, business_description,
         business_address, business_phone, business_email,
         store_logo_url, store_banner_url, store_theme, website, facebook, twitter, instagram,
         tiktok, telegram, category, is_verified
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, store_number, business_name, store_logo_url, is_verified, created_at`,
      [
        userId, storeNumber, storeSlug, storeName, storeDescription || null,
        businessAddress || null, businessPhone || null, businessEmail || null,
        storeLogoUrl || null, website || null,
        facebook || null, twitter || null, instagram || null,
        tiktok || null, telegram || null, category || null,
        true // inherits KYC verification
      ]
    );

    console.log(`✅ Store #${storeNumber} created for user ${userId}`);
    return sendSuccess(res, 201, 'Store created successfully', { store: result.rows[0] });
  } catch (err) {
    console.error('createStore error:', err);
    return sendError(res, 500, 'Error creating store', err.message);
  }
};

/* ─── GET /api/seller/stores/:storeId ───────────────────────────────────── */
/**
 * @desc  Get a single store's full profile (seller view)
 * @route GET /api/seller/stores/:storeId
 * @access Private (seller)
 */
const getStoreById = async (req, res) => {
  try {
    const userId  = req.user.id;
    const { storeId } = req.params;

    const result = await db.query(
      `SELECT
         s.*,
         (SELECT COUNT(*) FROM products p
          WHERE p.store_id = s.id
            AND p.is_active = true AND p.is_deleted = false) AS product_count
       FROM stores s
       WHERE s.id = $1 AND s.user_id = $2 AND s.is_deleted = false`,
      [storeId, userId]
    );

    if (!result.rows.length) return sendError(res, 404, 'Store not found');

    const s = result.rows[0];
    return sendSuccess(res, 200, 'Store fetched', {
      store: {
        ...s,
        rating:           parseFloat(s.rating)           || 0,
        totalEarnings:    parseFloat(s.total_earnings)    || 0,
        availableBalance: parseFloat(s.available_balance) || 0,
        productCount:     parseInt(s.product_count)       || 0,
      }
    });
  } catch (err) {
    console.error('getStoreById error:', err);
    return sendError(res, 500, 'Error fetching store', err.message);
  }
};

/* ─── PUT /api/seller/stores/:storeId ───────────────────────────────────── */
/**
 * @desc  Update store settings (shop settings page)
 * @route PUT /api/seller/stores/:storeId
 * @access Private (seller)
 */
const updateStore = async (req, res) => {
  try {
    const userId  = req.user.id;
    const { storeId } = req.params;

    if (!await ownsStore(userId, storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const {
      storeName, storeDescription, businessEmail, businessPhone,
      businessAddress, website, category, storeLogoUrl,
      facebook, twitter, tiktok, instagram, telegram
    } = req.body;

    if (!storeName) return sendError(res, 400, 'Store name is required');

    const storeSlug = slugify(storeName);

    const result = await db.query(
      `UPDATE stores SET
         slug                 = $1,
         business_name        = $2,
         business_description = $3,
         business_email       = $4,
         business_phone       = $5,
         business_address     = $6,
         store_logo_url       = COALESCE($7, store_logo_url),
         website              = $8,
         facebook             = $9,
         twitter              = $10,
         instagram            = $11,
         tiktok               = $12,
         telegram             = $13,
         category             = $14,
         store_banner_url     = COALESCE($15, store_banner_url),
         store_theme          = COALESCE($16, store_theme),
         updated_at           = NOW()
       WHERE id = $17
       RETURNING id, store_number, business_name, store_logo_url, store_banner_url, store_theme, updated_at`,
      [
        storeSlug,
        storeName, storeDescription || null, businessEmail || null,
        businessPhone || null, businessAddress || null,
        storeLogoUrl || null, website || null,
        facebook || null, twitter || null, instagram || null,
        tiktok || null, telegram || null, category || null,
        req.body.storeBannerUrl || null,
        req.body.storeTheme ? JSON.stringify(req.body.storeTheme) : null,
        storeId
      ]
    );

    console.log(`✅ Store ${storeId} updated by user ${userId}`);
    return sendSuccess(res, 200, 'Store updated successfully', { store: result.rows[0] });
  } catch (err) {
    console.error('updateStore error:', err);
    return sendError(res, 500, 'Error updating store', err.message);
  }
};

/* ─── GET /api/seller/stores/:storeId/stats ─────────────────────────────── */
/**
 * @desc  Get dashboard stats for a specific store
 * @route GET /api/seller/stores/:storeId/stats
 * @access Private (seller)
 */
const getStoreStats = async (req, res) => {
  try {
    const userId  = req.user.id;
    const { storeId } = req.params;

    if (!await ownsStore(userId, storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    // Order stats scoped to this store
    const orderStats = await db.query(
      `SELECT
         COUNT(DISTINCT o.id)                                          AS total_orders,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status='pending')       AS pending,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status='processing')    AS processing,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status='shipped')       AS shipped,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status='delivered')     AS delivered,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status='cancelled')     AS cancelled,
         COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)         AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.seller_id = $1 AND oi.store_id = $2`,
      [userId, storeId]
    );

    // Product count
    const productCount = await db.query(
      `SELECT COUNT(*) AS count FROM products
       WHERE seller_id = $1 AND store_id = $2
         AND is_active = true AND is_deleted = false`,
      [userId, storeId]
    );

    // Balance from earnings table (live compute instead of stale store denormalized columns)
    const earningsRes = await db.query(
      `SELECT COALESCE(SUM(net_amount) FILTER (WHERE status = 'available'), 0) AS total_earnings,
              COALESCE(SUM(net_amount) FILTER (WHERE status = 'available'), 0)
                - COALESCE(SUM(ABS(amount)) FILTER (WHERE status = 'withdrawn'), 0) AS available_balance
       FROM earnings WHERE seller_id = $1 AND store_id = $2`,
      [userId, storeId]
    );

    const o = orderStats.rows[0];
    const b = earningsRes.rows[0] || {};

    return sendSuccess(res, 200, 'Store stats fetched', {
      stats: {
        totalOrders:      parseInt(o.total_orders),
        pending:          parseInt(o.pending),
        processing:       parseInt(o.processing),
        shipped:          parseInt(o.shipped),
        delivered:        parseInt(o.delivered),
        cancelled:        parseInt(o.cancelled),
        totalRevenue:     parseFloat(o.total_revenue),
        productCount:     parseInt(productCount.rows[0].count),
        totalEarnings:    parseFloat(b.total_earnings)    || 0,
        availableBalance: parseFloat(b.available_balance) || 0,
      }
    });
  } catch (err) {
    console.error('getStoreStats error:', err);
    return sendError(res, 500, 'Error fetching store stats', err.message);
  }
};

/* ─── GET /api/seller/stores/public/:storeId ────────────────────────────── */
/**
 * @desc  Public store page (buyers view)
 * @route GET /api/seller/stores/public/:storeId
 * @access Public
 */
const getPublicStore = async (req, res) => {
  try {
    const { storeId } = req.params;

    const result = await db.query(
      `SELECT
         s.id, s.user_id AS seller_id, s.store_number,
         s.business_name, s.business_description,
         s.business_address, s.business_email, s.business_phone,
         s.store_logo_url, s.store_banner_url, s.store_theme,
         s.website, s.facebook, s.twitter,
         s.instagram, s.tiktok, s.telegram, s.category,
         s.rating, s.total_reviews, s.total_sales, s.is_verified,
         s.created_at,
         u.first_name, u.last_name, u.avatar_url,
         (SELECT COUNT(*) FROM products p
          WHERE p.store_id = s.id AND p.is_active = true AND p.is_deleted = false
         ) AS product_count
       FROM stores s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.is_active = true AND s.is_deleted = false`,
      [storeId]
    );

    if (!result.rows.length) return sendError(res, 404, 'Store not found');

    const s = result.rows[0];
    return sendSuccess(res, 200, 'Store fetched', {
      store: {
        storeId:             s.id,
        sellerId:            s.seller_id,
        storeNumber:         s.store_number,
        businessName:        s.business_name,
        businessDescription: s.business_description,
        businessAddress:     s.business_address,
        businessEmail:       s.business_email,
        businessPhone:       s.business_phone,
        storeLogo:           s.store_logo_url,
        storeBannerUrl:      s.store_banner_url,
        storeTheme:          s.store_theme,
        website:             s.website,
        socialLinks: {
          facebook:  s.facebook,
          twitter:   s.twitter,
          instagram: s.instagram,
          tiktok:    s.tiktok,
          telegram:  s.telegram,
        },
        category:     s.category,
        rating:       parseFloat(s.rating) || 0,
        totalReviews: s.total_reviews || 0,
        totalSales:   s.total_sales || 0,
        isVerified:   s.is_verified,
        productCount: parseInt(s.product_count) || 0,
        memberSince:  s.created_at,
        seller: {
          firstName: s.first_name,
          lastName:  s.last_name,
          avatarUrl: s.avatar_url,
        }
      }
    });
  } catch (err) {
    console.error('getPublicStore error:', err);
    return sendError(res, 500, 'Error fetching store', err.message);
  }
};

/* ─── GET /api/seller/stores/public/:storeId/products ───────────────────── */
/**
 * @desc  Public store products (buyers view)
 * @route GET /api/seller/stores/public/:storeId/products
 * @access Public
 */
const getPublicStoreProducts = async (req, res) => {
  try {
    const { storeId } = req.params;
    const { category, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = `WHERE p.store_id = $1 AND p.is_active = true AND p.is_deleted = false`;
    const params = [storeId];
    let idx = 2;

    if (category && category !== 'all') {
      where += ` AND LOWER(c.name) = $${idx++}`;
      params.push(category.toLowerCase());
    }

    const result = await db.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock_quantity,
              p.main_image_url, p.color, p.size,
              p."flash start" AS flash_start, p."flash end" AS flash_end,
              COALESCE(c.name, 'Uncategorized') AS category_name,
              COALESCE(
                (SELECT AVG(r.rating)::numeric(10,1) FROM reviews r
                 WHERE r.product_id = p.id AND r.is_deleted = false), 0
              ) AS avg_rating,
              (SELECT COUNT(*) FROM reviews r
               WHERE r.product_id = p.id AND r.is_deleted = false) AS review_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}`,
      params
    );

    const categoriesRes = await db.query(
      `SELECT DISTINCT COALESCE(c.name, 'Uncategorized') AS name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.store_id = $1 AND p.is_active = true AND p.is_deleted = false
       ORDER BY name`,
      [storeId]
    );

    return sendSuccess(res, 200, 'Store products fetched', {
      products: result.rows.map(p => ({
        ...p,
        price:       parseFloat(p.price),
        avgRating:   parseFloat(p.avg_rating),
        reviewCount: parseInt(p.review_count),
      })),
      categories:  categoriesRes.rows.map(r => r.name),
      total:       parseInt(countRes.rows[0].count),
      page:        parseInt(page),
      limit:       parseInt(limit),
    });
  } catch (err) {
    console.error('getPublicStoreProducts error:', err);
    return sendError(res, 500, 'Error fetching store products', err.message);
  }
};

module.exports = {
  getMyStores,
  createStore,
  getStoreById,
  updateStore,
  getStoreStats,
  getPublicStore,
  getPublicStoreProducts,
};