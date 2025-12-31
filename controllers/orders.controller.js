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
        'SELECT price, stock FROM products WHERE id = $1',
        [item.product_id]
      );

      if (product.rows.length === 0) {
        return sendError(res, 404, `Product ${item.product_id} not found`);
      }

      if (product.rows[0].stock < item.quantity) {
        return sendError(res, 400, `Insufficient stock for product ${item.product_id}`);
      }

      total_amount += product.rows[0].price * item.quantity;
    }

    // Create order
    const orderResult = await db.query(
      `INSERT INTO orders (
        user_id, total_amount, status, shipping_address, 
        payment_method, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, total_amount, status, created_at`,
      [user_id, total_amount, 'pending', shipping_address, payment_method, notes]
    );

    const order = orderResult.rows[0];

    // Create order items
    for (const item of items) {
      const product = await db.query(
        'SELECT price, name FROM products WHERE id = $1',
        [item.product_id]
      );

      await db.query(
        `INSERT INTO order_items (
          order_id, product_id, quantity, price, product_name
        ) VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.product_id, item.quantity, product.rows[0].price, product.rows[0].name]
      );

      // Update stock
      await db.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [item.quantity, item.product_id]
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

    const offset = (page - 1) * limit;
    const statusFilter = status ? `AND o.status = '${status}'` : '';

    // Read orders from `order_details` table using `buyer_id` and aggregate
    // item quantities from `order_items` for total items. This is resilient
    // if `order_details` does not carry per-item breakdown; it still returns
    // total_items computed from `order_items` when present.
    const result = await db.query(
      `SELECT
        o.order_id as id,
        o.total_amount,
        o.status,
        o.payment_method,
        o.created_at,
        COALESCE(SUM(oi.quantity), 0) as total_items
       FROM order_details o
       LEFT JOIN order_items oi ON o.order_id = oi.order_id
       WHERE o.buyer_id = $1 ${statusFilter}
       GROUP BY o.order_id, o.total_amount, o.status, o.payment_method, o.created_at
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM order_details WHERE buyer_id = $1 ${statusFilter}`,
      [user_id]
    );

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
              'price', oi.price
            )
          ) FILTER (WHERE oi.id IS NOT NULL), '[]'
        ) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.id = $1 AND o.user_id = $2
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

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'completed', 'cancelled'];
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
      'SELECT id, status FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, user_id]
    );

    if (orderCheck.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    if (!['pending', 'processing'].includes(orderCheck.rows[0].status)) {
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
        'UPDATE products SET stock = stock + $1 WHERE id = $2',
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
        p.images,
        p.price,
        oi.order_id AS "orderId",
        o.delivered_at AS "deliveredAt",
        EXISTS(
          SELECT 1 FROM reviews r 
          WHERE r.product_id = p.id 
          AND r.user_id = $1 
          AND r.is_deleted = FALSE
        ) AS "alreadyReviewed"
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.user_id = $1 
      AND o.status = 'delivered'
      AND o.delivered_at IS NOT NULL
      ORDER BY o.delivered_at DESC`,
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


module.exports = {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getPurchasedProducts
};