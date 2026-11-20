const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { slugify, uniqueAccountSlug } = require('../utils/slugify');
const { stripFee } = require('../utils/pricing');

/* ─── helpers ────────────────────────────────────────────────────────────── */

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

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

function parseAnalyticsMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return null;
  }

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (year < 1000) return null;

  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0));

  const formatUtcTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
  return {
    startTimestamp: formatUtcTimestamp(start),
    endTimestamp: formatUtcTimestamp(end)
  };
}

function getAnalyticsMonthHistory(month) {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const firstMonth = new Date(Date.UTC(year, monthNumber - 1 - 5, 1));
  const formatUtcTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - 1 - 5 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });

  return {
    months,
    startTimestamp: formatUtcTimestamp(firstMonth)
  };
}

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function getLagosDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function lagosMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - LAGOS_OFFSET_MS);
}

function parseAnalyticsRange(range, now = new Date()) {
  if (!['7days', '30days', '90days', 'year'].includes(range)) return null;

  const lagosToday = getLagosDateParts(now);
  let start;
  if (range === 'year') {
    start = lagosMidnightUtc(lagosToday.year, 1, 1);
  } else {
    const days = Number(range.replace('days', ''));
    start = lagosMidnightUtc(lagosToday.year, lagosToday.month, lagosToday.day);
    start = new Date(start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  }

  const todayStart = lagosMidnightUtc(lagosToday.year, lagosToday.month, lagosToday.day);
  const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  return {
    range,
    start,
    end,
    startTimestamp: start.toISOString(),
    endTimestamp: end.toISOString()
  };
}

function getRequestedAnalyticsRange(req) {
  const range = typeof req.query.range === 'string' ? req.query.range.trim() : '';
  if (!range) return null;
  return parseAnalyticsRange(range);
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
        accountSlug:      s.account_slug,
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

/* ─── GET /api/seller/stores/:storeId/followers ─────────────────────────── */
/**
 * @desc  Get the follower count for a store owned by the authenticated seller
 * @route GET /api/seller/stores/:storeId/followers
 * @access Private (seller)
 */
const getStoreFollowerCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { storeId } = req.params;

    if (!await ownsStore(userId, storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const result = await db.query(
      `SELECT COUNT(DISTINCT buyer_id) AS follower_count
       FROM shop_follows
       WHERE store_id = $1`,
      [storeId]
    );

    return sendSuccess(res, 200, 'Store followers fetched', {
      followerCount: parseInt(result.rows[0].follower_count, 10)
    });
  } catch (err) {
    console.error('getStoreFollowerCount error:', err);
    return sendError(res, 500, 'Error fetching store followers');
  }
};

const recordFeaturedStoreImpression = async (req, res) => {
  try {
    const { storeId } = req.params;
    if (!isUuid(storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const requestId = req.body?.request_id;
    if (!isUuid(requestId)) {
      return sendError(res, 400, 'A valid request_id is required');
    }

    const result = await db.transaction(async (client) => {
      const storeResult = await client.query(
        `SELECT id, user_id, is_active, is_deleted
         FROM stores
         WHERE id = $1
         FOR SHARE`,
        [storeId]
      );
      if (!storeResult.rows.length) {
        return { status: 'not-found' };
      }

      const store = storeResult.rows[0];
      if (!store.is_active || store.is_deleted) {
        return { status: 'not-found' };
      }

      const isSameImpression = (impression) => impression &&
        String(impression.store_id).toLowerCase() === String(store.id).toLowerCase() &&
        String(impression.seller_id).toLowerCase() === String(store.user_id).toLowerCase();
      const findDuplicate = async () => {
        const existingResult = await client.query(
          `SELECT store_id, seller_id
           FROM public.featured_store_impressions
           WHERE request_id = $1`,
          [requestId]
        );
        return isSameImpression(existingResult.rows[0])
          ? { status: 'success', storeId: store.id, duplicate: true }
          : { status: 'conflict' };
      };

      const insertResult = await client.query(
        `INSERT INTO public.featured_store_impressions (request_id, store_id, seller_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING id`,
        [requestId, store.id, store.user_id]
      );
      if (!insertResult.rows.length) {
        return findDuplicate();
      }

      return { status: 'success', storeId: store.id, duplicate: false };
    });

    if (result.status === 'not-found') {
      return sendError(res, 404, 'Store not found');
    }
    if (result.status === 'conflict') {
      return sendError(res, 409, 'request_id is already associated with a different store impression');
    }

    return sendSuccess(res, 200, 'Featured store impression recorded', {
      storeId: result.storeId,
      duplicate: result.duplicate
    });
  } catch (err) {
    console.error('recordFeaturedStoreImpression error:', err);
    return sendError(res, 500, 'Unable to record featured store impression');
  }
};

/* ─── GET /api/seller/stores/monthly-analytics ──────────────────────────── */
/**
 * @desc  Get monthly paid-order and sales totals for the authenticated seller's active store
 * @route GET /api/seller/stores/monthly-analytics
 * @access Private (seller)
 */
const getStoreMonthlyAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    const month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (!analyticsRange && !month) {
      return sendError(res, 400, 'An analytics range or month is required');
    }
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    const monthRange = month ? parseAnalyticsMonth(month) : null;
    if (month && !monthRange) {
      return sendError(res, 400, 'Invalid month. Use YYYY-MM');
    }

    const storeResult = await db.query(
      `SELECT id FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    if (analyticsRange) {
      const analyticsResult = await db.query(
        `SELECT
           TO_CHAR((o.paid_at AT TIME ZONE 'Africa/Lagos')::date, 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT o.id) AS order_count,
           COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0) AS gross_sales
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.seller_id = $1
           AND oi.store_id = $2
           AND o.payment_status = 'paid'
           AND o.paid_at >= $3::timestamptz
           AND o.paid_at < $4::timestamptz
           AND EXISTS (
             SELECT 1 FROM payment_transactions pt
             WHERE pt.order_id = o.id AND pt.status = 'success'
           )
         GROUP BY (o.paid_at AT TIME ZONE 'Africa/Lagos')::date
         ORDER BY (o.paid_at AT TIME ZONE 'Africa/Lagos')::date`,
        [sellerId, storeId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
      );

      let grossMonthlySales = 0;
      let monthlyOrderCount = 0;
      const periodHistory = analyticsResult.rows.map((row) => {
        const gross = parseFloat(row.gross_sales) || 0;
        const orders = parseInt(row.order_count, 10) || 0;
        grossMonthlySales += gross;
        monthlyOrderCount += orders;
        return {
          day: row.day,
          monthlyOrderCount: orders,
          grossMonthlySales: Number(gross.toFixed(2)),
          netMonthlySales: Number(stripFee(gross).toFixed(2))
        };
      });

      const netMonthlySales = stripFee(grossMonthlySales);
      return sendSuccess(res, 200, 'Range store analytics fetched', {
        storeId,
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp,
        currency: 'NGN',
        monthlyOrderCount,
        grossMonthlySales: Number(grossMonthlySales.toFixed(2)),
        netMonthlySales: Number(netMonthlySales.toFixed(2)),
        monthlyHistory: periodHistory,
        periodHistory
      });
    }

    const historyRange = getAnalyticsMonthHistory(month);
    const analyticsResult = await db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', o.paid_at), 'YYYY-MM') AS month,
         COUNT(DISTINCT o.id) AS monthly_order_count,
         COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0) AS gross_monthly_sales
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.seller_id = $1
         AND oi.store_id = $2
         AND o.payment_status = 'paid'
         AND o.paid_at >= $3::timestamp
         AND o.paid_at < $4::timestamp
         AND EXISTS (
           SELECT 1
           FROM payment_transactions pt
           WHERE pt.order_id = o.id
             AND pt.status = 'success'
         )
       GROUP BY DATE_TRUNC('month', o.paid_at)
       ORDER BY DATE_TRUNC('month', o.paid_at)`,
      [sellerId, storeId, historyRange.startTimestamp, monthRange.endTimestamp]
    );

    const rowsByMonth = new Map(analyticsResult.rows.map((row) => [row.month, row]));
    const monthlyHistory = historyRange.months.map((historyMonth) => {
      const row = rowsByMonth.get(historyMonth) || {};
      const monthlyOrderCount = parseInt(row.monthly_order_count, 10) || 0;
      const grossMonthlySales = parseFloat(row.gross_monthly_sales) || 0;
      const netMonthlySales = stripFee(grossMonthlySales);
      return {
        month: historyMonth,
        monthlyOrderCount,
        grossMonthlySales: Number(grossMonthlySales.toFixed(2)),
        netMonthlySales: Number(netMonthlySales.toFixed(2))
      };
    });
    const currentMonth = monthlyHistory[monthlyHistory.length - 1];

    return sendSuccess(res, 200, 'Monthly store analytics fetched', {
      storeId,
      month,
      currency: 'NGN',
      monthlyOrderCount: currentMonth.monthlyOrderCount,
      grossMonthlySales: currentMonth.grossMonthlySales,
      netMonthlySales: currentMonth.netMonthlySales,
      monthlyHistory
    });
  } catch (err) {
    console.error('getStoreMonthlyAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch monthly store analytics');
  }
};

/* ─── GET /api/seller/stores/review-analytics ──────────────────────────── */
/**
 * @desc  Get visible review totals for the authenticated seller's active store
 * @route GET /api/seller/stores/review-analytics
 * @access Private (seller)
 */
const getStoreReviewAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }

    const storeResult = await db.query(
      `SELECT id FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    const rangePredicate = analyticsRange
      ? 'AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz'
      : '';
    const analyticsResult = await db.query(
      `SELECT
         COUNT(r.id)::integer AS total_reviews,
         ROUND(COALESCE(AVG(r.rating), 0)::numeric, 2) AS average_rating
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       WHERE r.is_deleted = false
         AND r.is_approved = true
         AND r.moderation_status = 'published'
         AND p.is_deleted = false
         AND p.store_id = $1
         AND p.seller_id = $2
         ${rangePredicate}`,
      analyticsRange
        ? [storeId, sellerId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
        : [storeId, sellerId]
    );

    const analytics = analyticsResult.rows[0];
    return sendSuccess(res, 200, 'Store review analytics fetched', {
      storeId,
      ...(analyticsRange ? {
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp
      } : {}),
      totalReviews: Number(analytics.total_reviews),
      averageRating: Number(analytics.average_rating)
    });
  } catch (err) {
    console.error('getStoreReviewAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch store review analytics');
  }
};

/* ─── GET /api/seller/stores/product-view-analytics ─────────────────────── */
/**
 * @desc  Get product view totals for the authenticated seller's active store
 * @route GET /api/seller/stores/product-view-analytics
 * @access Private (seller)
 */
const getStoreProductViewAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }

    const storeResult = await db.query(
      `SELECT id FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    const analyticsResult = analyticsRange
      ? await db.query(
          `WITH product_totals AS (
             SELECT ve.product_id,
                    COUNT(*)::bigint AS views
             FROM public.view_events ve
             WHERE ve.view_type = 'product'
               AND ve.store_id = $1
               AND ve.seller_id = $2
               AND ve.viewed_at >= $3::timestamptz
               AND ve.viewed_at < $4::timestamptz
             GROUP BY ve.product_id
           )
           SELECT COALESCE(SUM(pt.views), 0)::bigint AS total_product_views,
                  COALESCE(
                    json_agg(
                      json_build_object(
                        'productId', pt.product_id,
                        'productName', COALESCE(p.name, 'Deleted or unavailable product'),
                        'views', pt.views
                      )
                      ORDER BY COALESCE(p.name, 'Deleted or unavailable product'), pt.product_id
                    ), '[]'::json
                  ) AS products
           FROM product_totals pt
           LEFT JOIN products p ON p.id = pt.product_id`,
          [storeId, sellerId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
        )
      : await db.query(
          `SELECT
             COALESCE(SUM(COALESCE(p.views, 0)), 0)::bigint AS total_product_views,
             COALESCE(
               json_agg(
                 json_build_object(
                   'productId', p.id,
                   'productName', p.name,
                   'views', COALESCE(p.views, 0)
                 )
                 ORDER BY p.name, p.id
               ) FILTER (WHERE p.id IS NOT NULL),
               '[]'::json
             ) AS products
           FROM products p
           WHERE p.store_id = $1
             AND p.seller_id = $2
             AND p.is_active = true
             AND p.is_deleted = false`,
          [storeId, sellerId]
        );

    const analytics = analyticsResult.rows[0];
    return sendSuccess(res, 200, 'Store product view analytics fetched', {
      storeId,
      ...(analyticsRange ? {
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp
      } : {}),
      totalProductViews: Number(analytics.total_product_views),
      products: analytics.products
    });
  } catch (err) {
    console.error('getStoreProductViewAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch store product view analytics');
  }
};

/* ─── POST /api/seller/stores/public/:storeId/view ───────────────────────── */
/**
 * @desc  Record a visit to a public, active store
 * @route POST /api/seller/stores/public/:storeId/view
 * @access Public
 */
const recordStoreView = async (req, res) => {
  try {
    const { storeId } = req.params;
    if (!isUuid(storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const requestId = req.body?.request_id;
    if (!isUuid(requestId)) {
      return sendError(res, 400, 'A valid request_id is required');
    }

    const result = await db.transaction(async (client) => {
      const storeResult = await client.query(
        `SELECT id, user_id, views, is_active, is_deleted
         FROM stores
         WHERE id = $1
         FOR UPDATE`,
        [storeId]
      );
      if (!storeResult.rows.length) {
        return { status: 'not-found' };
      }

      const store = storeResult.rows[0];
      const isSameStoreEvent = (existingEvent) => existingEvent &&
        existingEvent.view_type === 'store' &&
        String(existingEvent.store_id).toLowerCase() === String(store.id).toLowerCase() &&
        existingEvent.product_id == null &&
        String(existingEvent.seller_id).toLowerCase() === String(store.user_id).toLowerCase();
      const readExistingEvent = async () => {
        if (!store.is_active || store.is_deleted) {
          return { status: 'not-found' };
        }
        const existingEventResult = await client.query(
          `SELECT view_type, store_id, product_id, seller_id
           FROM public.view_events
           WHERE request_id = $1`,
          [requestId]
        );
        return isSameStoreEvent(existingEventResult.rows[0])
          ? { status: 'success', storeId: store.id, views: Number(store.views) }
          : { status: 'conflict' };
      };

      if (!store.is_active || store.is_deleted) {
        return { status: 'not-found' };
      }

      const priorEventResult = await client.query(
        `SELECT view_type, store_id, product_id, seller_id
         FROM public.view_events
         WHERE request_id = $1`,
        [requestId]
      );
      if (priorEventResult.rows.length) {
        return isSameStoreEvent(priorEventResult.rows[0])
          ? { status: 'success', storeId: store.id, views: Number(store.views) }
          : { status: 'conflict' };
      }
      const eventResult = await client.query(
        `INSERT INTO public.view_events (request_id, view_type, store_id, product_id, seller_id)
         VALUES ($1, 'store', $2, NULL, $3)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING id`,
        [requestId, store.id, store.user_id]
      );

      if (!eventResult.rows.length) {
        return readExistingEvent();
      }

      const updateResult = await client.query(
        `UPDATE stores
         SET views = COALESCE(views, 0) + 1
         WHERE id = $1 AND is_active = true AND is_deleted = false
         RETURNING id, views`,
        [store.id]
      );
      if (!updateResult.rows.length) {
        throw new Error('Store disappeared while recording a view');
      }

      return {
        status: 'success',
        storeId: updateResult.rows[0].id,
        views: Number(updateResult.rows[0].views)
      };
    });

    if (result.status === 'not-found') {
      return sendError(res, 404, 'Store not found');
    }
    if (result.status === 'conflict') {
      return sendError(res, 409, 'request_id is already associated with a different view');
    }

    return sendSuccess(res, 200, 'Store view tracked', {
      storeId: result.storeId,
      views: result.views
    });
  } catch (err) {
    console.error('recordStoreView error:', err);
    return sendError(res, 500, 'Unable to track store view');
  }
};

/* ─── GET /api/seller/stores/store-view-analytics ───────────────────────── */
/**
 * @desc  Get view totals for the authenticated seller's active store
 * @route GET /api/seller/stores/store-view-analytics
 * @access Private (seller)
 */
const getStoreViewAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }
    if (!isUuid(storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const storeResult = await db.query(
      `SELECT id, views FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    if (analyticsRange) {
      const rangeResult = await db.query(
        `SELECT COUNT(*)::bigint AS store_views
         FROM public.view_events
         WHERE view_type = 'store'
           AND store_id = $1
           AND seller_id = $2
           AND viewed_at >= $3::timestamptz
           AND viewed_at < $4::timestamptz`,
        [storeId, sellerId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
      );
      return sendSuccess(res, 200, 'Range store view analytics fetched', {
        storeId: storeResult.rows[0].id,
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp,
        storeViews: Number(rangeResult.rows[0].store_views)
      });
    }

    return sendSuccess(res, 200, 'Store view analytics fetched', {
      storeId: storeResult.rows[0].id,
      storeViews: Number(storeResult.rows[0].views)
    });
  } catch (err) {
    console.error('getStoreViewAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch store view analytics');
  }
};

const getFeaturedStoreImpressionAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }
    if (!isUuid(storeId)) {
      return sendError(res, 404, 'Store not found');
    }

    const storeResult = await db.query(
      `SELECT id FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    const analyticsResult = await db.query(
      analyticsRange
        ? `SELECT COUNT(*)::bigint AS impression_count
           FROM public.featured_store_impressions
           WHERE store_id = $1 AND seller_id = $2
             AND viewed_at >= $3::timestamptz
             AND viewed_at < $4::timestamptz`
        : `SELECT COUNT(*)::bigint AS impression_count
           FROM public.featured_store_impressions
           WHERE store_id = $1 AND seller_id = $2`,
      analyticsRange
        ? [storeId, sellerId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
        : [storeId, sellerId]
    );

    return sendSuccess(res, 200, 'Featured store impression analytics fetched', {
      storeId: storeResult.rows[0].id,
      ...(analyticsRange ? {
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp
      } : {}),
      impressionCount: Number(analyticsResult.rows[0].impression_count)
    });
  } catch (err) {
    console.error('getFeaturedStoreImpressionAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch featured store impression analytics');
  }
};

/* ─── GET /api/seller/stores/refund-analytics ──────────────────────────── */
/**
 * @desc  Get refund report totals for the authenticated seller's active store
 * @route GET /api/seller/stores/refund-analytics
 * @access Private (seller)
 */
const getStoreRefundAnalytics = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const headerStoreId = typeof req.headers['x-store-id'] === 'string'
      ? req.headers['x-store-id'].trim()
      : '';
    const storeId = headerStoreId || (typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '');

    if (!storeId) {
      return sendError(res, 400, 'Active store ID is required');
    }

    const storeResult = await db.query(
      `SELECT id FROM stores
       WHERE id = $1 AND user_id = $2
         AND is_deleted = false AND is_active = true
       LIMIT 1`,
      [storeId, sellerId]
    );
    if (!storeResult.rows.length) {
      return sendError(res, 404, 'Store not found');
    }

    const analyticsRange = getRequestedAnalyticsRange(req);
    if (req.query.range && !analyticsRange) {
      return sendError(res, 400, 'Invalid range. Use 7days, 30days, 90days or year');
    }

    const rangePredicate = analyticsRange
      ? 'AND rc.created_at >= $3::timestamptz AND rc.created_at < $4::timestamptz'
      : '';
    const analyticsResult = await db.query(
      `SELECT COUNT(DISTINCT rc.id)::integer AS refund_reports_received
       FROM refund_cases rc
       JOIN order_items oi
         ON oi.id = rc.order_item_id
        AND oi.order_id = rc.order_id::uuid
        AND oi.seller_id = rc.seller_id
       WHERE oi.store_id = $1
         AND oi.seller_id = $2
         ${rangePredicate}`,
      analyticsRange
        ? [storeId, sellerId, analyticsRange.startTimestamp, analyticsRange.endTimestamp]
        : [storeId, sellerId]
    );

    return sendSuccess(res, 200, 'Store refund analytics fetched', {
      storeId,
      ...(analyticsRange ? {
        range: analyticsRange.range,
        rangeStart: analyticsRange.startTimestamp,
        rangeEnd: analyticsRange.endTimestamp
      } : {}),
      refundReportsReceived: Number(analyticsResult.rows[0].refund_reports_received)
    });
  } catch (err) {
    console.error('getStoreRefundAnalytics error:', err);
    return sendError(res, 500, 'Unable to fetch store refund analytics');
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

    const sellerCheck = await db.query(
      `SELECT u.is_suspended, u.suspended_until
       FROM users u JOIN stores s ON s.user_id = u.id WHERE s.id = $1`,
      [storeId]
    );
    const seller = sellerCheck.rows[0];
    if (seller?.is_suspended && (!seller.suspended_until || new Date(seller.suspended_until) > new Date())) {
      return sendError(res, 404, 'Store not found');
    }

    const result = await db.query(
      `SELECT
         s.id, s.user_id AS seller_id, s.store_number,
         s.business_name, s.business_description,
         s.business_address, s.business_email, s.business_phone,
         s.store_logo_url, s.store_banner_url, s.store_theme,
         s.website, s.facebook, s.twitter,
         s.instagram, s.tiktok, s.telegram, s.category,
         s.is_verified,
         s.created_at,
         u.first_name, u.last_name, u.avatar_url,
         COALESCE((
           SELECT AVG(r.rating)::numeric(10,1)
           FROM reviews r
           JOIN products p ON p.id = r.product_id
           WHERE (p.store_id = s.id OR (p.store_id IS NULL AND p.seller_id = s.user_id))
             AND r.is_deleted = false AND r.is_approved = true
             AND to_jsonb(r)->>'moderation_status' = 'published'
         ), 0) AS rating,
         COALESCE((
           SELECT COUNT(*)
           FROM reviews r
           JOIN products p ON p.id = r.product_id
           WHERE (p.store_id = s.id OR (p.store_id IS NULL AND p.seller_id = s.user_id))
             AND r.is_deleted = false AND r.is_approved = true
             AND to_jsonb(r)->>'moderation_status' = 'published'
         ), 0) AS total_reviews,
         COALESCE((
           SELECT COUNT(DISTINCT o.id)
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE (oi.store_id = s.id OR (oi.store_id IS NULL AND oi.seller_id = s.user_id))
             AND o.status NOT IN ('cancelled', 'payment_failed', 'awaiting_payment')
         ), 0) AS total_sales,
         (SELECT COUNT(*) FROM products p
          WHERE (p.store_id = s.id OR (p.store_id IS NULL AND p.seller_id = s.user_id))
            AND p.is_active = true AND p.is_deleted = false
            AND NOT EXISTS (
              SELECT 1 FROM users suspended_user
              WHERE suspended_user.id = p.seller_id AND suspended_user.is_suspended = true
               AND (suspended_user.suspended_until IS NULL OR suspended_user.suspended_until > NOW())
            )
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
        totalReviews: parseInt(s.total_reviews) || 0,
        totalSales:   parseInt(s.total_sales) || 0,
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

    let where = `WHERE p.store_id = $1 AND p.is_active = true AND p.is_deleted = false
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = p.seller_id AND u.is_suspended = true
          AND (u.suspended_until IS NULL OR u.suspended_until > NOW())
      )`;
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
                 WHERE r.product_id = p.id AND r.is_deleted = false
                   AND r.is_approved = true
                   AND to_jsonb(r)->>'moderation_status' = 'published'), 0
              ) AS avg_rating,
              (SELECT COUNT(*) FROM reviews r
               WHERE r.product_id = p.id AND r.is_deleted = false
                 AND r.is_approved = true
                 AND to_jsonb(r)->>'moderation_status' = 'published') AS review_count
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
         AND NOT EXISTS (
           SELECT 1 FROM users u
           WHERE u.id = p.seller_id AND u.is_suspended = true
             AND (u.suspended_until IS NULL OR u.suspended_until > NOW())
         )
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
  getStoreFollowerCount,
  recordFeaturedStoreImpression,
  getFeaturedStoreImpressionAnalytics,
  getStoreMonthlyAnalytics,
  getStoreReviewAnalytics,
  getStoreProductViewAnalytics,
  recordStoreView,
  getStoreViewAnalytics,
  getStoreRefundAnalytics,
  parseAnalyticsMonth,
  parseAnalyticsRange,
  getPublicStore,
  getPublicStoreProducts,
};