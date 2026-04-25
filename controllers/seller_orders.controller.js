const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Get all orders containing this seller's products
 * @route   GET /api/seller/orders
 * @access  Private (seller only)
 * @query   status, page, limit, search
 */
const getSellerOrders = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { status, page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build WHERE conditions
    const conditions = [`oi.seller_id = $1`];
    const params = [sellerId];
    let idx = 2;

    // Valid statuses that map to DB
    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (status && status !== 'all' && validStatuses.includes(status.toLowerCase())) {
      conditions.push(`o.status = $${idx++}`);
      params.push(status.toLowerCase());
    }

    if (search) {
      conditions.push(`(
        CAST(o.id AS TEXT) ILIKE $${idx} OR
        LOWER(u.first_name || ' ' || u.last_name) LIKE $${idx} OR
        LOWER(p.name) LIKE $${idx}
      )`);
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    // Main query — one row per order_item so sellers see each line item
    const ordersQuery = `
      SELECT
        o.id               AS order_id,
        o.status,
        o.created_at,
        o.shipping_address,
        u.id               AS buyer_id,
        u.first_name       AS buyer_first_name,
        u.last_name        AS buyer_last_name,
        u.email            AS buyer_email,
        oi.id              AS order_item_id,
        oi.quantity,
        oi.price_at_purchase,
        p.id               AS product_id,
        p.name             AS product_name,
        p.main_image_url   AS product_image,
        (oi.quantity * oi.price_at_purchase) AS line_total
      FROM order_items oi
      JOIN orders o       ON o.id        = oi.order_id
      JOIN users u        ON u.id        = o.buyer_id
      JOIN products p     ON p.id        = oi.product_id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(parseInt(limit), offset);

    // Count query (distinct orders for pagination)
    const countQuery = `
      SELECT COUNT(DISTINCT o.id) AS total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN users u  ON u.id = o.buyer_id
      JOIN products p ON p.id = oi.product_id
      WHERE ${whereClause}
    `;
    // count params exclude limit/offset
    const countParams = params.slice(0, params.length - 2);

    const [ordersResult, countResult] = await Promise.all([
      db.query(ordersQuery, params),
      db.query(countQuery, countParams),
    ]);

    // Group line items back under each order
    const ordersMap = new Map();
    for (const row of ordersResult.rows) {
      if (!ordersMap.has(row.order_id)) {
        ordersMap.set(row.order_id, {
          orderId: row.order_id,
          status: row.status,
          createdAt: row.created_at,
          shippingAddress: row.shipping_address,
          buyer: {
            id: row.buyer_id,
            name: `${row.buyer_first_name} ${row.buyer_last_name}`.trim(),
            email: row.buyer_email,
          },
          items: [],
          totalAmount: 0,
        });
      }
      const order = ordersMap.get(row.order_id);
      order.items.push({
        orderItemId: row.order_item_id,
        productId: row.product_id,
        productName: row.product_name,
        productImage: row.product_image,
        quantity: row.quantity,
        priceAtPurchase: parseFloat(row.price_at_purchase),
        lineTotal: parseFloat(row.line_total),
      });
      order.totalAmount += parseFloat(row.line_total);
    }

    const orders = Array.from(ordersMap.values());
    const total = parseInt(countResult.rows[0].total);

    return sendSuccess(res, 200, 'Seller orders fetched successfully', {
      orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('getSellerOrders error:', error);
    return sendError(res, 500, 'Error fetching seller orders', error.message);
  }
};

/**
 * @desc    Get a single order's detail (only if seller has items in it)
 * @route   GET /api/seller/orders/:orderId
 * @access  Private (seller only)
 */
const getSellerOrderById = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { orderId } = req.params;

    const result = await db.query(
      `SELECT
        o.id               AS order_id,
        o.status,
        o.created_at,
        o.shipping_address,
        o.payment_method,
        o.notes,
        u.id               AS buyer_id,
        u.first_name       AS buyer_first_name,
        u.last_name        AS buyer_last_name,
        u.email            AS buyer_email,
        u.phone            AS buyer_phone,
        oi.id              AS order_item_id,
        oi.quantity,
        oi.price_at_purchase,
        p.id               AS product_id,
        p.name             AS product_name,
        p.main_image_url   AS product_image
       FROM order_items oi
       JOIN orders o    ON o.id = oi.order_id
       JOIN users u     ON u.id = o.buyer_id
       JOIN products p  ON p.id = oi.product_id
       WHERE o.id = $1 AND oi.seller_id = $2
       ORDER BY oi.id`,
      [orderId, sellerId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Order not found or does not contain your products');
    }

    const first = result.rows[0];
    const order = {
      orderId: first.order_id,
      status: first.status,
      createdAt: first.created_at,
      shippingAddress: first.shipping_address,
      paymentMethod: first.payment_method,
      notes: first.notes,
      buyer: {
        id: first.buyer_id,
        name: `${first.buyer_first_name} ${first.buyer_last_name}`.trim(),
        email: first.buyer_email,
        phone: first.buyer_phone,
      },
      items: result.rows.map(r => ({
        orderItemId: r.order_item_id,
        productId: r.product_id,
        productName: r.product_name,
        productImage: r.product_image,
        quantity: r.quantity,
        priceAtPurchase: parseFloat(r.price_at_purchase),
        lineTotal: r.quantity * parseFloat(r.price_at_purchase),
      })),
      totalAmount: result.rows.reduce(
        (sum, r) => sum + r.quantity * parseFloat(r.price_at_purchase),
        0
      ),
    };

    return sendSuccess(res, 200, 'Order detail fetched', { order });
  } catch (error) {
    console.error('getSellerOrderById error:', error);
    return sendError(res, 500, 'Error fetching order', error.message);
  }
};

/**
 * @desc    Update order status (seller can move: pending→processing→shipped)
 * @route   PUT /api/seller/orders/:orderId/status
 * @access  Private (seller only)
 *
 * Sellers are allowed to advance status forward only.
 * They cannot cancel or mark as delivered (that's the buyer/admin privilege).
 */
const updateSellerOrderStatus = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { orderId } = req.params;
    const { status } = req.body;

    // Statuses a seller is allowed to set
    const sellerAllowedStatuses = ['confirmed', 'processing', 'shipped'];

    if (!status || !sellerAllowedStatuses.includes(status.toLowerCase())) {
      return sendError(
        res,
        400,
        `Invalid status. Sellers can set: ${sellerAllowedStatuses.join(', ')}`
      );
    }

    // Verify the order contains at least one item from this seller
    const ownerCheck = await db.query(
      `SELECT o.id, o.status
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1 AND oi.seller_id = $2
       LIMIT 1`,
      [orderId, sellerId]
    );

    if (ownerCheck.rows.length === 0) {
      return sendError(res, 404, 'Order not found or does not contain your products');
    }

    const currentStatus = ownerCheck.rows[0].status;

    // Enforce forward-only progression
    const progression = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
    const currentIdx = progression.indexOf(currentStatus);
    const newIdx = progression.indexOf(status.toLowerCase());

    if (newIdx <= currentIdx) {
      return sendError(
        res,
        400,
        `Cannot move order from "${currentStatus}" to "${status}". Status can only move forward.`
      );
    }

    const result = await db.query(
      `UPDATE orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [status.toLowerCase(), orderId]
    );

    console.log(`✅ Seller ${sellerId} updated order ${orderId}: ${currentStatus} → ${status}`);

    return sendSuccess(res, 200, `Order status updated to "${status}"`, {
      order: result.rows[0],
    });
  } catch (error) {
    console.error('updateSellerOrderStatus error:', error);
    return sendError(res, 500, 'Error updating order status', error.message);
  }
};

/**
 * @desc    Get order summary stats for the seller dashboard widget
 * @route   GET /api/seller/orders/stats
 * @access  Private (seller only)
 */
const getSellerOrderStats = async (req, res) => {
  try {
    const sellerId = req.user.id;

    const result = await db.query(
      `SELECT
        COUNT(DISTINCT o.id)                                             AS total_orders,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending')        AS pending,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'processing')     AS processing,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'shipped')        AS shipped,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered')      AS delivered,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'cancelled')      AS cancelled,
        COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)            AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.seller_id = $1`,
      [sellerId]
    );

    const row = result.rows[0];
    return sendSuccess(res, 200, 'Order stats fetched', {
      stats: {
        totalOrders: parseInt(row.total_orders),
        pending: parseInt(row.pending),
        processing: parseInt(row.processing),
        shipped: parseInt(row.shipped),
        delivered: parseInt(row.delivered),
        cancelled: parseInt(row.cancelled),
        totalRevenue: parseFloat(row.total_revenue),
      },
    });
  } catch (error) {
    console.error('getSellerOrderStats error:', error);
    return sendError(res, 500, 'Error fetching order stats', error.message);
  }
};

module.exports = {
  getSellerOrders,
  getSellerOrderById,
  updateSellerOrderStatus,
  getSellerOrderStats,
};