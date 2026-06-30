/**
 * controllers/seller_orders.controller.js
 *
 * Diff from original: updateSellerOrderStatus now calls logActivity()
 * so every status transition (confirmed / processing / shipped) is recorded.
 * Everything else is unchanged.
 */

const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { logActivity } = require('./seller_activity.controller');
const { notifySeller, notifyBuyer } = require('../utils/sellerEmailService');

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ACTIVITY_TYPE_MAP = {
  confirmed:  'order_confirmed',
  processing: 'order_processing',
  shipped:    'order_shipped',
  delivered:  'order_delivered',
  cancelled:  'order_cancelled',
};

// ─── GET /api/seller/orders ───────────────────────────────────────────────────
const getSellerOrders = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId = req.headers['x-store-id'] || req.query.storeId;
    const { status, page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [`oi.seller_id = $1`];
    const params = [sellerId];
    let idx = 2;

    if (storeId) {
      conditions.push(`oi.store_id = $${idx++}`);
      params.push(storeId);
    }

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (status && status !== 'all' && validStatuses.includes(status.toLowerCase())) {
      conditions.push(`o.status = $${idx++}`);
      params.push(status.toLowerCase());
    }

    if (search) {
      conditions.push(`(CAST(o.id AS TEXT) ILIKE $${idx} OR LOWER(u.first_name || ' ' || u.last_name) LIKE $${idx} OR LOWER(p.name) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    const ordersQuery = `
      SELECT
        o.id               AS order_id,
        o.status,
        o.created_at,
        o.shipping_address,
        o.delivery_method,
        o.courier_name,
        o.tracking_id,
        o.tracking_link,
        u.id               AS buyer_id,
        u.first_name       AS buyer_first_name,
        u.last_name        AS buyer_last_name,
        u.email            AS buyer_email,
        oi.id              AS order_item_id,
        oi.quantity,
        oi.price_at_purchase,
        oi.product_snapshot,
        oi.color,
        oi.size,
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

    const countQuery = `
      SELECT COUNT(DISTINCT o.id) AS total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN users u  ON u.id = o.buyer_id
      JOIN products p ON p.id = oi.product_id
      WHERE ${whereClause}
    `;
    const countParams = params.slice(0, params.length - 2);

    const [ordersResult, countResult] = await Promise.all([
      db.query(ordersQuery, params),
      db.query(countQuery, countParams),
    ]);

    const ordersMap = new Map();
    for (const row of ordersResult.rows) {
      if (!ordersMap.has(row.order_id)) {
        ordersMap.set(row.order_id, {
          orderId: row.order_id,
          status: row.status,
          createdAt: row.created_at,
          shippingAddress: row.shipping_address,
           deliveryMethod: row.delivery_method,
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
        productSnapshot: row.product_snapshot,
        color: row.color,
        size: row.size,
      });
      order.totalAmount += parseFloat(row.line_total);
    }

    const orders = Array.from(ordersMap.values());
    const total  = parseInt(countResult.rows[0].total);

    return sendSuccess(res, 200, 'Seller orders fetched successfully', {
      orders,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error('getSellerOrders error:', error);
    return sendError(res, 500, 'Error fetching seller orders', error.message);
  }
};

// ─── GET /api/seller/orders/:orderId ─────────────────────────────────────────
const getSellerOrderById = async (req, res) => {
  try {
    const sellerId   = req.user.id;
    const { orderId } = req.params;

    const result = await db.query(
      `SELECT
        o.id               AS order_id,
        o.status,
        o.created_at,
        o.shipping_address,
        o.payment_method,
        o.delivery_method,
        o.courier_name,
        o.tracking_id,
        o.tracking_link,
        o.notes,
        u.id               AS buyer_id,
        u.first_name       AS buyer_first_name,
        u.last_name        AS buyer_last_name,
        u.email            AS buyer_email,
        u.phone            AS buyer_phone,
        oi.id              AS order_item_id,
        oi.quantity,
        oi.price_at_purchase,
        oi.product_snapshot,
        oi.color,
        oi.size,
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

    if (result.rows.length === 0) return sendError(res, 404, 'Order not found or does not contain your products');

    const first = result.rows[0];
    const order = {
      orderId: first.order_id,
      status:  first.status,
      createdAt: first.created_at,
      shippingAddress: first.shipping_address,
      paymentMethod: first.payment_method,
      notes: first.notes,
     deliveryMethod: first.delivery_method,
      buyer: {
        id:    first.buyer_id,
        name:  `${first.buyer_first_name} ${first.buyer_last_name}`.trim(),
        email: first.buyer_email,
        phone: first.buyer_phone,
      },
      items: result.rows.map(r => ({
        orderItemId: r.order_item_id,
        productId:   r.product_id,
        productName: r.product_name,
        productImage: r.product_image,
        quantity:    r.quantity,
        priceAtPurchase: parseFloat(r.price_at_purchase),
        lineTotal:   r.quantity * parseFloat(r.price_at_purchase),
        productSnapshot: r.product_snapshot,
        color: r.color,
        size: r.size,
      })),
      totalAmount: result.rows.reduce((sum, r) => sum + r.quantity * parseFloat(r.price_at_purchase), 0),
    };

    console.log('Loaded order item specifications', {
      orderId,
      sellerId,
      items: order.items,
    });
    return sendSuccess(res, 200, 'Order detail fetched', { order });
  } catch (error) {
    console.error('getSellerOrderById error:', error);
    return sendError(res, 500, 'Error fetching order', error.message);
  }
};

// ─── PUT /api/seller/orders/:orderId/status ───────────────────────────────────
const updateSellerOrderStatus = async (req, res) => {
  try {
    const sellerId   = req.user.id;
    const { orderId } = req.params;
    const { status }  = req.body;

    console.log('updateSellerOrderStatus called:', { sellerId, orderId, status }); // ADD THIS

    const sellerAllowedStatuses = ['confirmed', 'processing', 'shipped', 'delivered'];
    if (!status || !sellerAllowedStatuses.includes(status.toLowerCase())) {
      return sendError(res, 400, `Invalid status. Sellers can set: ${sellerAllowedStatuses.join(', ')}`);
    }

    const ownerCheck = await db.query(
      `SELECT o.id, o.status
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1 AND oi.seller_id = $2
       LIMIT 1`,
      [orderId, sellerId]
    );

    if (ownerCheck.rows.length === 0) return sendError(res, 404, 'Order not found or does not contain your products');

    const currentStatus = ownerCheck.rows[0].status;
    const newStatusLower = status.toLowerCase();
    const progression   = ['awaiting_payment', 'pending', 'confirmed', 'processing', 'shipped', 'delivered'];
    const currentIdx    = progression.indexOf(currentStatus);
    const newIdx        = progression.indexOf(newStatusLower);

    // Allow if same status (idempotent) or forward progression
    if (newIdx < currentIdx) {
      return sendError(res, 400, `Cannot move order from "${currentStatus}" to "${status}". Status can only move forward.`);
    }
    // If already at this status, just return success silently
    if (newIdx === currentIdx) {
      const existingRow = ownerCheck.rows[0];
      return sendSuccess(res, 200, `Order is already "${status}"`, { order: { id: existingRow.id, status: currentStatus, updated_at: new Date() } });
    }

    // After validation, replace the UPDATE query:
// updateSellerOrderStatus — replace the orders UPDATE with vendor_orders
const result = await db.query(
  `UPDATE vendor_orders SET status=$1, updated_at=NOW(),
     tracking_code = COALESCE($3, tracking_code),
     courier_name  = COALESCE($4, courier_name),
     tracking_link = COALESCE($5, tracking_link)
   WHERE order_id=$2 AND seller_id=$6
   RETURNING id, status, updated_at, tracking_code, courier_name, tracking_link`,
  [status.toLowerCase(), orderId, req.body.trackingId || null,
   req.body.courierName || null, req.body.trackingLink || null, sellerId]
);

    const shortId   = String(orderId).substring(0, 8);
    const actType   = ACTIVITY_TYPE_MAP[status.toLowerCase()] || 'order_updated';
    const label     = status.charAt(0).toUpperCase() + status.slice(1);
    const buyerId   = result.rows[0].buyer_id;

    // ── Create seller notification ──
    await db.query(
      `INSERT INTO notifications 
         (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, FALSE, FALSE, NOW(), NOW())`,
      [
        sellerId,
        `Order #${shortId} marked as ${label}`,
        `Status changed from ${currentStatus} to ${status}`,
        'order'
      ]
    );

    

    const orderSummaryResult = await db.query(
      `SELECT
         COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0) AS total_amount,
         COALESCE(json_agg(json_build_object('productName', p.name)) FILTER (WHERE p.id IS NOT NULL), '[]') AS items
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 AND oi.seller_id = $2`,
      [orderId, sellerId]
    );
    const order = {
      totalAmount: parseFloat(orderSummaryResult.rows[0].total_amount),
      items: orderSummaryResult.rows[0].items,
    };

    
    // ── Create buyer notification for tracking status update ──
    const statusMessages = {
      confirmed:  `Your order #${shortId} has been confirmed! Seller is preparing it for shipment.`,
      processing: `Your order #${shortId} is being processed. Packaging in progress.`,
      shipped:    `Your order #${shortId} has been shipped! Track your package to see delivery updates.`,
      delivered:  `Your order #${shortId} has been delivered! Thank you for shopping with us.`,
      cancelled:  `Your order #${shortId} has been cancelled. Please check your account for details.`,
    };

    const statusBuyerTitle = {
      confirmed:  'Order Confirmed',
      processing: 'Order Processing',
      shipped:    'Order Shipped',
      delivered:  'Order Delivered',
      cancelled:  'Order Cancelled',
    };

    const buyerMessage = statusMessages[newStatusLower] || `Your order #${shortId} status has been updated to ${label}.`;
    const buyerTitle = statusBuyerTitle[newStatusLower] || `Order Update: ${label}`;

    try {
  await db.query(
    `INSERT INTO notifications (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, NOW(), NOW())`,
    [buyerId, 
      buyerTitle, 
      buyerMessage, 'order', '/buyers/buyers%20order%20&%20tracking.html']
  );
} catch (notifErr) {
  console.error(`⚠️ Failed to create buyer notification:`, notifErr.message);
}

// Run independently — a notifications-table failure must never block these
if (buyerId) {
  if (newStatusLower === 'processing') notifyBuyer(buyerId, 'orderProcessing', { orderId }).catch(e => console.error('EMAIL FAIL:', e));
  if (newStatusLower === 'shipped') {
    const { trackingId, courierName, trackingLink, estimatedDelivery } = req.body;
    notifyBuyer(buyerId, 'orderShipped', { orderId, trackingId, courierName, trackingLink, estimatedDelivery }).catch(e => console.error('EMAIL FAIL:', e));
  }
  if (newStatusLower === 'delivered') notifyBuyer(buyerId, 'orderDelivered', { orderId }).catch(e => console.error('EMAIL FAIL:', e));
}

    // ── Activity log ──
    await logActivity({
      sellerId,
      type:       actType,
      title:      `Order #${shortId} marked as ${label}`,
      detail:     `Status changed from ${currentStatus} → ${status}`,
      entityId:   orderId,
      entityType: 'order',
    });

    console.log(`✅ Seller ${sellerId} updated order ${orderId}: ${currentStatus} → ${status}`);

    return sendSuccess(res, 200, `Order status updated to "${status}"`, { order: result.rows[0] });
  } catch (error) {
    console.error('updateSellerOrderStatus FULL error:', error); // ADD THIS
    return sendError(res, 500, 'Error updating order status', error.message);
  }
};

// ─── GET /api/seller/orders/stats ────────────────────────────────────────────
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
        totalOrders:   parseInt(row.total_orders),
        pending:       parseInt(row.pending),
        processing:    parseInt(row.processing),
        shipped:       parseInt(row.shipped),
        delivered:     parseInt(row.delivered),
        cancelled:     parseInt(row.cancelled),
        totalRevenue:  parseFloat(row.total_revenue),
      },
    });
  } catch (error) {
    console.error('getSellerOrderStats error:', error);
    return sendError(res, 500, 'Error fetching order stats', error.message);
  }
};

module.exports = { getSellerOrders, getSellerOrderById, updateSellerOrderStatus, getSellerOrderStats };
