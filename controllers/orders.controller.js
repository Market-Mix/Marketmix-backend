const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');
 const { notifySeller } = require('../utils/sellerEmailService');
 const { notifyBuyer } = require('../utils/sellerEmailService');

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

      console.log('Saving order item specifications', {
        orderId: order.id,
        productId: item.product_id,
        color: item.color || null,
        size: item.size || null,
      });
      await db.query(
        `INSERT INTO order_items (
          order_id, product_id, seller_id, quantity, price_at_purchase, color, size
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.product_id, sellerId, item.quantity, product.rows[0].price, item.color || null, item.size || null]
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

      notifySeller(sellerId, 'newOrder', {
        orderId: order.id, buyerName, amount: total_amount,
      }).catch(() => {});
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
    
    // Build query - join products and seller info to get product names and seller store names
    let sql = `WITH order_sellers AS (
  SELECT DISTINCT order_id, seller_id FROM order_items WHERE seller_id IS NOT NULL
)
SELECT
  o.id, o.total_amount, o.status, o.created_at, o.delivery_confirmed_at,
  o.payment_status, o.payment_method, o.delivery_method,
  COALESCE(json_agg(
    json_build_object(
      'sellerId',     os.seller_id,
      'sellerName',   COALESCE(sp.business_name, su.first_name || ' ' || su.last_name),
      'vendorOrderId', vo.id,
      'status',       COALESCE(vo.status, o.status),
      'courierName',  COALESCE(vo.courier_name, o.courier_name),
      'trackingCode', COALESCE(vo.tracking_code, o.tracking_id),
      'trackingLink', COALESCE(vo.tracking_link, o.tracking_link),
      'shippingFee',  vo.shipping_fee,
      'items',        seller_items.items
    ) ORDER BY os.seller_id
  ) FILTER (WHERE os.seller_id IS NOT NULL), '[]') AS seller_groups
FROM orders o
JOIN order_sellers os ON os.order_id = o.id
LEFT JOIN vendor_orders vo ON vo.order_id = o.id AND vo.seller_id = os.seller_id
LEFT JOIN users su ON su.id = os.seller_id
LEFT JOIN seller_profiles sp ON sp.user_id = os.seller_id
LEFT JOIN LATERAL (
  SELECT json_agg(
    json_build_object(
      'id', oi.id, 'productId', oi.product_id, 'productName', p.name,
      'image', p.main_image_url, 'quantity', oi.quantity,
      'price', oi.price_at_purchase, 'color', oi.color, 'size', oi.size
    ) ORDER BY oi.created_at
  ) AS items
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
  WHERE oi.order_id = o.id AND oi.seller_id = os.seller_id
) seller_items ON true
WHERE o.buyer_id = $1`;

const params = [user_id];

if (status) {
  sql += ` AND o.status = $2`;
  params.push(status);
}

sql += ` GROUP BY o.id
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
  `WITH order_sellers AS (
     SELECT DISTINCT order_id, seller_id FROM order_items WHERE order_id = $1 AND seller_id IS NOT NULL
   )
   SELECT
     o.id, o.total_amount, o.status, o.shipping_address, o.payment_method,
     o.notes, o.created_at, o.updated_at,
     COALESCE(json_agg(
       json_build_object(
         'sellerId',     os.seller_id,
         'sellerName',   COALESCE(sp.business_name, su.first_name || ' ' || su.last_name),
         'vendorOrderId', vo.id,
         'status',       COALESCE(vo.status, o.status),
         'courierName',  COALESCE(vo.courier_name, o.courier_name),
         'trackingCode', COALESCE(vo.tracking_code, o.tracking_id),
         'trackingLink', COALESCE(vo.tracking_link, o.tracking_link),
         'shippingFee',  vo.shipping_fee,
         'items',        seller_items.items
       ) ORDER BY os.seller_id
     ) FILTER (WHERE os.seller_id IS NOT NULL), '[]') AS seller_groups
   FROM orders o
   JOIN order_sellers os ON os.order_id = o.id
   LEFT JOIN vendor_orders vo ON vo.order_id = o.id AND vo.seller_id = os.seller_id
   LEFT JOIN users su ON su.id = os.seller_id
   LEFT JOIN seller_profiles sp ON sp.user_id = os.seller_id
   LEFT JOIN LATERAL (
     SELECT json_agg(
       json_build_object(
         'id', oi.id, 'productId', oi.product_id, 'productName', p.name,
         'image', p.main_image_url, 'quantity', oi.quantity,
         'price', oi.price_at_purchase, 'color', oi.color, 'size', oi.size
       ) ORDER BY oi.created_at
     ) AS items
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = o.id AND oi.seller_id = os.seller_id
   ) seller_items ON true
   WHERE o.id = $1 AND o.buyer_id = $2
   GROUP BY o.id`,
  [orderId, user_id]
);

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    const order = result.rows[0];
    console.log('Loaded order item specifications', {
      orderId,
      items: order.items || []
    });

    return sendSuccess(res, 200, 'Order fetched successfully', {
      order
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
       RETURNING id, status, updated_at, buyer_id`,
      [status, orderId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Order not found');
    }

    const order = result.rows[0];
    const shortId = String(orderId).substring(0, 8);
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    const buyerId = order.buyer_id;

    // ── Create buyer notification for tracking status update ──
    const statusMessages = {
      confirmed:  `Your order #${shortId} has been confirmed! Seller is preparing it for shipment.`,
      processing: `Your order #${shortId} is being processed. Packaging in progress.`,
      shipped:    `Your order #${shortId} has been shipped! Track your package to see delivery updates.`,
      delivered:  `Your order #${shortId} has been delivered! Thank you for shopping with us.`,
      cancelled:  `Your order #${shortId} has been cancelled. Please check your account for details.`,
      refunded:   `Your order #${shortId} has been refunded. Check your account for payment details.`,
      returned:   `Your order #${shortId} has been returned. Thank you for your business.`,
      pending:    `Your order #${shortId} is pending confirmation.`,
    };

    const statusBuyerTitle = {
      confirmed:  'Order Confirmed',
      processing: 'Order Processing',
      shipped:    'Order Shipped',
      delivered:  'Order Delivered',
      cancelled:  'Order Cancelled',
      refunded:   'Order Refunded',
      returned:   'Order Returned',
      pending:    'Order Pending',
    };

    const buyerMessage = statusMessages[status] || `Your order #${shortId} status has been updated to ${label}.`;
    const buyerTitle = statusBuyerTitle[status] || `Order Update: ${label}`;

    try {
  await db.query(
    `INSERT INTO notifications 
       (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, NOW(), NOW())`,
    [buyerId, buyerTitle, buyerMessage, 'order', '/buyers/buyers%20order%20&%20tracking.html']
  );

if (status === 'processing') notifyBuyer(buyerId, 'orderProcessing', { orderId }).catch(e => console.error('EMAIL FAIL:', e));
if (status === 'shipped')    notifyBuyer(buyerId, 'orderShipped', {
  orderId,
  trackingId: req.body.trackingId,
  courierName: req.body.courierName,
  trackingLink: req.body.trackingLink
}).catch(e => console.error('EMAIL FAIL:', e));

if (status === 'delivered')  notifyBuyer(buyerId, 'orderDelivered', { orderId }).catch(e => console.error('EMAIL FAIL:', e));
          console.log(`✅ Buyer notification created for order #${shortId} status: ${status}`);
    } catch (notifErr) {
      console.error(`⚠️ Failed to create buyer notification for order #${shortId}:`, notifErr.message);
      // Don't fail the entire request if notification fails - just log it
    }

   console.log(`✅ Order ${orderId} status updated to ${status}`);

return sendSuccess(res, 200, 'Order status updated successfully', {
  order: {
    id: order.id,
    status: order.status,
    updated_at: order.updated_at
  }
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

    const sellerRows = await db.query(
  `SELECT DISTINCT seller_id FROM order_items WHERE order_id = $1`, [orderId]
);
for (const row of sellerRows.rows) {
  notifySeller(row.seller_id, 'orderCancelled', { orderId, buyerName: 'Buyer' }).catch(() => {});
}

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

       notifyBuyer(user_id, 'orderDelivered', { 
      orderId 
     }).catch(e => console.error('EMAIL FAIL:', e));
    
    // Release escrow when buyer confirms delivery
    const escrowUpdate = await db.query(
      `UPDATE escrow_transactions
       SET status = 'released',
           released_at = NOW(),
           updated_at = NOW()
       WHERE order_id = $1 AND status = 'held'
       RETURNING seller_id, amount`,
      [orderId]
    );

    // Credit seller balance and insert earnings per released escrow row
   if (escrowUpdate.rows.length) {
      for (const { seller_id, amount } of escrowUpdate.rows) {
        const netAmount = stripFee(amount);

        await db.query(
          `UPDATE seller_profiles
           SET available_balance = available_balance + $1,
               total_earnings = total_earnings + $1,
               updated_at = NOW()
           WHERE user_id = $2`,
          [netAmount, seller_id]
        );

        try {
          await db.query(
            `INSERT INTO notifications
               (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
             VALUES ($1,'Funds Released',$2,'payment',$3,FALSE,FALSE,NOW(),NOW())`,
            [
              seller_id,
              `₦${netAmount.toFixed(2)} has been released to your account for order #${orderId.toString().slice(0,8).toUpperCase()}.`,
              '/sellers/sellers%20earning.html'
            ]
          );
        } catch (e) {
          console.error('Notification insert failed:', e.message);
        }

        notifySeller(seller_id, 'paymentReceived', {
          orderId, amount: netAmount
        }).catch(() => {});

        // insert one earnings row per order_item for this seller/order so
        // Recent Transactions + Product Revenue tables populate
        try {
          const items = await db.query(
            `SELECT id, product_id, quantity, price_at_purchase FROM order_items WHERE order_id=$1 AND seller_id=$2`,
            [orderId, seller_id]
          );

          for (const it of items.rows) {
            const gross = parseFloat(it.price_at_purchase) * it.quantity;
            await db.query(
              `INSERT INTO earnings (seller_id, order_id, order_item_id, amount, net_amount, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'available',NOW())`,
              [seller_id, orderId, it.id, gross, stripFee(gross)]
            );
          }
        } catch (e) {
          console.error('Earnings insert failed for seller', seller_id, e.message);
        }
      }
    }
  

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

    const escrowCheck = await db.query(
      `SELECT id, status FROM escrow_transactions WHERE order_id=$1 LIMIT 1`,
      [orderId]
    );

    if (!escrowCheck.rows.length || escrowCheck.rows[0].status === 'released') {
      return sendError(res, 400, 'Dispute window has closed, funds already released to seller');
    }

    await db.query(
      `UPDATE escrow_transactions SET status='disputed', updated_at=NOW()
       WHERE order_id=$1 AND status='held'`,
      [orderId]
    );

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



/**
 * @desc    Retry payment for an unpaid order
 * @route   POST /api/orders/:orderId/retry-payment
 * @access  Private (Buyer)
 */
async function retryOrderPayment(req, res) {
  try {
    const { orderId } = req.params;
    const user_id = req.user.id;

    // Verify order belongs to buyer and is unpaid
    const orderRes = await db.query(
      `SELECT o.*, u.email, u.first_name, u.last_name, u.phone
       FROM orders o JOIN users u ON u.id = o.buyer_id
       WHERE o.id = $1 AND o.buyer_id = $2 
       AND o.payment_status = 'unpaid'
      AND o.status IN ('awaiting_payment', 'pending')`,
      [orderId, user_id]
    );

    if (!orderRes.rows.length) {
      return sendError(res, 404, 'Order not found or already paid');
    }

    const order = orderRes.rows[0];
    const marketpay = require('../services/marketpay.service');

    const payResult = await marketpay.initiatePayment('paystack', {
      orderId: order.id,
      amount: parseFloat(order.total_amount),
      currency: 'NGN',
      email: order.email,
      name: `${order.first_name} ${order.last_name}`.trim(),
      phone: order.phone,
      callbackUrl: `${process.env.APP_BASE_URL}/api/payments/paystack/callback`,
      metadata: { userId: user_id, retry: true },
    });

    // Save new payment transaction attempt
    await db.query(
      `INSERT INTO payment_transactions
         (order_id, user_id, provider, provider_reference, amount, currency, status, created_at)
       VALUES ($1,$2,'paystack',$3,$4,'NGN','pending',NOW())`,
      [order.id, user_id, payResult.reference, parseFloat(order.total_amount)]
    );

    return sendSuccess(res, 200, 'Payment retry initiated', {
      paymentUrl: payResult.authorizationUrl,
      reference: payResult.reference,
    });
  } catch (error) {
    console.error('retryOrderPayment error:', error);
    return sendError(res, 500, 'Error retrying payment', error.message);
  }
}


module.exports = {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getPurchasedProducts,
  confirmDelivery,
  submitReport,
  getBuyerReports,
  retryOrderPayment
};