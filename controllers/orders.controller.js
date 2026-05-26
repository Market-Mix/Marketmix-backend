const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Create a new order
 * @route   POST /api/orders
 * @access  Private
 */
const createOrder = async (req, res) => {
  try {
    const { items, shipping_address, payment_method, notes } = req.body;
    const user_id = req.user.id;

    // Validation
    if (!items || items.length === 0) {
      return sendError(res, 400, 'Order must contain at least one item');
    }

    if (!shipping_address) {
      return sendError(res, 400, 'Shipping address is required');
    }

    // Calculate total
    let total_amount = 0;
    for (const item of items) {
      const product = await db.query(
        'SELECT price, stock_quantity, seller_id FROM products WHERE id = $1',
        [item.product_id]
      );

      if (product.rows.length === 0) {
        return sendError(res, 404, `Product ${item.product_id} not found`);
      }

      if (product.rows[0].stock_quantity < item.quantity) {
        return sendError(res, 400, `Insufficient stock for product ${item.product_id}`);
      }

      total_amount += product.rows[0].price * item.quantity;
    }

    // Create order
    const orderResult = await db.query(
      `INSERT INTO orders (
        buyer_id, total_amount, status, shipping_address, 
        payment_method, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, total_amount, status, created_at`,
      [user_id, total_amount, 'pending', shipping_address, payment_method, notes]
    );

    const order = orderResult.rows[0];

    // Create order items
    const sellerIds = new Set();
    for (const item of items) {
      const product = await db.query(
        'SELECT price, seller_id FROM products WHERE id = $1',
        [item.product_id]
      );
      const sellerId = product.rows[0].seller_id;
      sellerIds.add(sellerId);

      await db.query(
        `INSERT INTO order_items (
          order_id, product_id, seller_id, quantity, price_at_purchase
        ) VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.product_id, sellerId, item.quantity, product.rows[0].price]
      );

      // Update stock
      await db.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Create seller notifications for each seller involved in this order.
    const buyerResult = await db.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [user_id]
    );
    const buyerName = buyerResult.rows.length
      ? `${buyerResult.rows[0].first_name || ''} ${buyerResult.rows[0].last_name || ''}`.trim()
      : 'a buyer';

    for (const sellerId of sellerIds) {
      await db.query(
        `INSERT INTO notifications
           (user_id, title, message, type, data, is_read, is_deleted, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,FALSE,FALSE,NOW(),NOW())`,
        [
          sellerId,
          'New Order Received',
          `You have received a new order from ${buyerName}.`,
          'order',
          JSON.stringify({ orderId: order.id, link: '/sellers/sellers order.html' })
        ]
      );
    }

    console.log(`✅ Order created: ID ${order.id} by user ${user_id}`);

    return sendSuccess(res, 201, 'Order created successfully', {
      order: {
        id: order.id,
        totalAmount: order.total_amount,
        status: order.status,
        createdAt: order.created_at
      }
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    return sendError(res, 500, 'Error creating order', error);
  }
};

/**
 * @desc    Get user's orders
 * @route   GET /api/orders
 * @access  Private
 */
const getUserOrders = async (req, res) => {
  try {
    const user_id = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;
    
    console.log(`📋 [Orders] Fetching orders for buyer_id=${user_id}, status=${status || 'all'}, page=${page}`);

    const offset = (page - 1) * limit;
    
    // Build query - join products table to get product names
    let sql = `SELECT
      o.id,
      o.total_amount,
      o.status,
      o.created_at,
      COALESCE(SUM(oi.quantity), 0) as total_items,
      COALESCE(
        json_agg(
          json_build_object(
            'id', oi.id,
            'product_id', oi.product_id,
            'product_name', p.name,
            'quantity', oi.quantity,
            'price', oi.price_at_purchase
          ) ORDER BY oi.created_at
        ) FILTER (WHERE oi.id IS NOT NULL), '[]'
      ) as items
     FROM orders o
     LEFT JOIN order_items oi ON o.id = oi.order_id
     LEFT JOIN products p ON oi.product_id = p.id
     WHERE o.buyer_id = $1`;
    
    const params = [user_id];
    
    // Add status filter if provided
    if (status) {
      sql += ` AND o.status = $2`;
      params.push(status);
    }
    
    sql += ` GROUP BY o.id, o.total_amount, o.status, o.created_at
             ORDER BY o.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    
    params.push(limit, offset);
    
    console.log(`🔍 [Orders] Executing query with params:`, params);
    
    // Execute main query
    const result = await db.query(sql, params);

    // Build count query
    let countSql = `SELECT COUNT(*) as total FROM orders o WHERE o.buyer_id = $1`;
    const countParams = [user_id];
    
    if (status) {
      countSql += ` AND o.status = $2`;
      countParams.push(status);
    }
    
    const countResult = await db.query(countSql, countParams);

    console.log(`✅ [Orders] Found ${result.rows.length} orders`);

    return sendSuccess(res, 200, 'Orders fetched successfully', {
      orders: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(countResult.rows[0].total / limit),
        totalItems: parseInt(countResult.rows[0].total)
      }
    });

  } catch (error) {
    console.error('❌ Get user orders error:', error);
    return sendError(res, 500, 'Error fetching orders', error);
  }
};

/**
 * @desc    Get order by ID
 * @route   GET /api/orders/:orderId
 * @access  Private
 */
const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user_id = req.user.id;

    const result = await db.query(
      `SELECT 
        o.id, o.total_amount, o.status, o.shipping_address, 
        o.payment_method, o.notes, o.created_at, o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', oi.id,
              'product_id', oi.product_id,
              'product_name', p.name,
              'quantity', oi.quantity,
              'price', oi.price_at_purchase
            )
          ) FILTER (WHERE oi.id IS NOT NULL), '[]'
        ) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.id = $1 AND o.buyer_id = $2
       GROUP BY o.id`,
      [orderId, user_id]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    return sendSuccess(res, 200, 'Order fetched successfully', {
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Get order by ID error:', error);
    return sendError(res, 500, 'Error fetching order', error);
  }
};

/**
 * @desc    Update order status
 * @route   PUT /api/orders/:orderId/status
 * @access  Private (Admin/Seller)
 */
const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'];
    if (!validStatuses.includes(status)) {
      return sendError(res, 400, 'Invalid status');
    }

    const result = await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING id, status, updated_at`,
      [status, orderId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    console.log(`✅ Order ${orderId} status updated to ${status}`);

    return sendSuccess(res, 200, 'Order status updated successfully', {
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update order status error:', error);
    return sendError(res, 500, 'Error updating order status', error);
  }
};

/**
 * @desc    Cancel order
 * @route   PUT /api/orders/:orderId/cancel
 * @access  Private
 */
const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user_id = req.user.id;

    // Get order
    const orderCheck = await db.query(
      'SELECT id, status FROM orders WHERE id = $1 AND buyer_id = $2',
      [orderId, user_id]
    );

    if (orderCheck.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    if (!['pending', 'confirmed', 'processing'].includes(orderCheck.rows[0].status)) {
      return sendError(res, 400, 'Order cannot be cancelled at this stage');
    }

    // Update status
    await db.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Restore stock
    const items = await db.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );

    for (const item of items.rows) {
      await db.query(
        'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    console.log(`✅ Order ${orderId} cancelled by user ${user_id}`);

    return sendSuccess(res, 200, 'Order cancelled successfully');

  } catch (error) {
    console.error('❌ Cancel order error:', error);
    return sendError(res, 500, 'Error cancelling order', error);
  }
};

/**
 * @desc    Get all purchased products for review (delivered orders only)
 * @route   GET /api/orders/purchased-products
 * @access  Private
 */
const getPurchasedProducts = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT DISTINCT
        p.id,
        p.name,
        p.main_image_url as image,
        p.price,
        oi.order_id AS "orderId",
        o.updated_at AS "deliveredAt",
        EXISTS(
          SELECT 1 FROM reviews r 
          WHERE r.product_id = p.id 
          AND r.user_id = $1 
          AND r.is_deleted = FALSE
        ) AS "alreadyReviewed"
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.buyer_id = $1 
      AND o.status = 'delivered'
      ORDER BY o.updated_at DESC`,
      [userId]
    );

    return sendSuccess(res, 200, 'Purchased products fetched successfully', {
      products: result.rows
    });
  } catch (error) {
    console.error('Get purchased products error:', error);
    return sendError(res, 500, 'Error fetching purchased products', error);
  }
};

/**
 * @desc    Confirm delivery of an order
 * @route   POST /api/orders/:orderId/confirm-delivery
 * @access  Private (Buyer)
 */
const confirmDelivery = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user_id = req.user.id;

    // Check if order exists and belongs to user
    const orderCheck = await db.query(
      'SELECT id, status FROM orders WHERE id = $1 AND buyer_id = $2',
      [orderId, user_id]
    );

    if (orderCheck.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    // Update order status and set delivery_confirmed_at timestamp
    const result = await db.query(
      `UPDATE orders 
       SET status = 'delivered', delivery_confirmed_at = NOW(), updated_at = NOW() 
       WHERE id = $1 
       RETURNING id, status, delivery_confirmed_at`,
      [orderId]
    );

    console.log(`✅ Delivery confirmed for order ${orderId} by user ${user_id}`);

    return sendSuccess(res, 200, 'Delivery confirmed successfully', {
      order: result.rows[0],
      message: 'You now have 24 hours to report any issues with this order'
    });

  } catch (error) {
    console.error('❌ Confirm delivery error:', error);
    return sendError(res, 500, 'Error confirming delivery', error);
  }
};

/**
 * @desc    Submit a return/refund report
 * @route   POST /api/orders/:orderId/report
 * @access  Private (Buyer)
 */
const submitReport = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason, description } = req.body;
    const user_id = req.user.id;
    const evidenceFile = req.file;

    // Validation
    if (!reason || !description) {
      return sendError(res, 400, 'Reason and description are required');
    }

    if (!evidenceFile) {
      return sendError(res, 400, 'Evidence file (image or video) is required');
    }

    // Check if order exists and belongs to user
    const orderCheck = await db.query(
      'SELECT id, status, delivery_confirmed_at FROM orders WHERE id = $1 AND buyer_id = $2',
      [orderId, user_id]
    );

    if (orderCheck.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    const order = orderCheck.rows[0];

    // Check if order is in delivered status
    if (order.status !== 'delivered') {
      return sendError(res, 400, 'Reports can only be submitted for delivered orders');
    }

    // Check if report is submitted within 24 hours of delivery confirmation
    const now = new Date();
    const deliveryTime = order.delivery_confirmed_at ? new Date(order.delivery_confirmed_at) : null;
    
    if (!deliveryTime) {
      return sendError(res, 400, 'Please confirm delivery first before submitting a report');
    }

    const hoursDiff = (now - deliveryTime) / (1000 * 60 * 60);
    if (hoursDiff > 24) {
      return sendError(res, 400, 'Reports can only be submitted within 24 hours of delivery confirmation');
    }

    // Store evidence file (you'll need to set up file storage - cloud storage like AWS S3 or local storage)
    let evidenceUrl = null;
    if (evidenceFile) {
      // For now, store the file path or URL
      // In production, upload to S3 or another cloud service
      evidenceUrl = `/uploads/reports/${orderId}-${Date.now()}-${evidenceFile.originalname}`;
    }

    // Insert report into database
    const reportResult = await db.query(
      `INSERT INTO order_reports (
        order_id, buyer_id, reason, description, evidence_url, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, order_id, reason, description, evidence_url, status, created_at`,
      [orderId, user_id, reason, description, evidenceUrl, 'pending']
    );

    const report = reportResult.rows[0];

    console.log(`✅ Report submitted for order ${orderId} by user ${user_id}, Report ID: ${report.id}`);

    // Send auto-reply notification (this could be a job queue in production)
    // For now, we'll just send the response
    notify('Report submitted', `Your report has been received. Case ID: ${report.id}`);

    return sendSuccess(res, 201, 'Report submitted successfully', {
      report: {
        id: report.id,
        orderId: report.order_id,
        reason: report.reason,
        status: report.status,
        createdAt: report.created_at
      },
      autoReply: {
        message: '📧 Auto Reply from MarketMix: Thank you for reporting this issue. Please be patient while the seller reviews and responds to your case. We will keep you updated on the progress.',
        caseId: report.id
      }
    });

  } catch (error) {
    console.error('❌ Submit report error:', error);
    return sendError(res, 500, 'Error submitting report', error);
  }
};

/**
 * @desc    Get all reports for a buyer
 * @route   GET /api/orders/reports
 * @access  Private (Buyer)
 */
const getBuyerReports = async (req, res) => {
  try {
    const user_id = req.user.id;
    const { page = 1, limit = 10, status } = req.query;

    const offset = (page - 1) * limit;

    let sql = `SELECT 
      r.id,
      r.order_id,
      r.reason,
      r.description,
      r.evidence_url,
      r.status,
      r.created_at,
      o.total_amount,
      o.shipping_address
    FROM order_reports r
    JOIN orders o ON r.order_id = o.id
    WHERE r.buyer_id = $1`;

    const params = [user_id];

    if (status) {
      sql += ` AND r.status = $${params.length + 1}`;
      params.push(status);
    }

    sql += ` ORDER BY r.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);

    const result = await db.query(sql, params);

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM order_reports WHERE buyer_id = $1`;
    const countParams = [user_id];
    if (status) {
      countSql += ` AND status = $2`;
      countParams.push(status);
    }

    const countResult = await db.query(countSql, countParams);

    return sendSuccess(res, 200, 'Reports fetched successfully', {
      reports: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(countResult.rows[0].total / limit),
        totalItems: parseInt(countResult.rows[0].total)
      }
    });

  } catch (error) {
    console.error('❌ Get buyer reports error:', error);
    return sendError(res, 500, 'Error fetching reports', error);
  }
};

const notify = (title, message) => {
  // This is a placeholder for notification logic
  console.log(`📧 Notification: ${title} - ${message}`);
};

module.exports = {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getPurchasedProducts,
  confirmDelivery,
  submitReport,
  getBuyerReports
};