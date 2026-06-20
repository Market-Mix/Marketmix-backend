const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { notifySeller, notifyBuyer } = require('../utils/sellerEmailService');

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_err) {
      return fallback;
    }
  }
  return value;
}

function money(value) {
  return Number(parseFloat(value || 0).toFixed(2));
}

function buildShippingAddress(address) {
  return [
    address.address_line1,
    address.address_line2,
    address.city,
    address.state,
    address.postal_code,
    address.country,
  ].filter(Boolean).join(', ');
}

function groupBySeller(items) {
  return items.reduce((groups, item) => {
    const sellerId = item.seller_id;
    if (!sellerId) return groups;

    if (!groups[sellerId]) {
      groups[sellerId] = {
        sellerId,
        storeId: item.store_id || null,
        subtotal: 0,
        items: [],
      };
    }

    const unitPrice = money(item.price || item.unit_price);
    const quantity = parseInt(item.quantity, 10);

    groups[sellerId].items.push({
      ...item,
      price: unitPrice,
      quantity,
    });
    groups[sellerId].subtotal = money(groups[sellerId].subtotal + unitPrice * quantity);

    return groups;
  }, {});
}

async function fetchSellerDeliveries(client, sessionId) {
  const r = await client.query(
    `SELECT seller_id, method, provider_id, fee FROM checkout_session_deliveries WHERE checkout_session_id=$1`,
    [sessionId]
  );
  return new Map(r.rows.map(row => [row.seller_id, row]));
}

async function fetchOrderSummary(client, orderId, userId) {
  const result = await client.query(
    `SELECT
       o.*,
       COALESCE(
         json_agg(
           json_build_object(
             'id', vo.id,
             'sellerId', vo.seller_id,
             'storeId', vo.store_id,
             'status', vo.status,
             'subtotal', vo.subtotal,
             'shippingFee', vo.shipping_fee
           ) ORDER BY vo.created_at
         ) FILTER (WHERE vo.id IS NOT NULL), '[]'
       ) AS vendor_orders
     FROM orders o
     LEFT JOIN vendor_orders vo ON vo.order_id = o.id
     WHERE o.id = $1 AND o.buyer_id = $2
     GROUP BY o.id`,
    [orderId, userId]
  );

  return result.rows[0] || null;
}

async function clearCart(client, userId) {
  const cartRes = await client.query(
    `SELECT id FROM cart
     WHERE user_id = $1 AND is_active = true AND is_deleted = false
     LIMIT 1`,
    [userId]
  );

  if (cartRes.rows.length) {
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartRes.rows[0].id]);
  }
}

/**
 * Confirm checkout and create persisted order records.
 *
 * POST /api/checkout/session/:sessionId/confirm
 * Body: { payment_method?: 'paystack', notes?: string }
 */
const confirmCheckout = async (req, res) => {
  const client = await db.pool.connect();

  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId || req.body.sessionId;
    const paymentMethod = req.body.payment_method || req.body.paymentMethod || null;
    const notes = req.body.notes || null;

    if (!sessionId) {
      return sendError(res, 400, 'sessionId is required');
    }

    await client.query('BEGIN');

    const sessionRes = await client.query(
      `SELECT *
       FROM checkout_sessions
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [sessionId, userId]
    );

    if (!sessionRes.rows.length) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Checkout session not found');
    }

    const session = sessionRes.rows[0];

    if (session.order_id) {
      const existingOrder = await fetchOrderSummary(client, session.order_id, userId);
      await client.query('COMMIT');
      return sendSuccess(res, 200, 'Checkout already confirmed', {
        order: existingOrder,
        idempotent: true,
      });
    }

    if (['expired', 'abandoned'].includes(session.status) || new Date(session.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return sendError(res, 410, 'Checkout session has expired. Please start again.');
    }

    if (!session.address_id || !session.address_snapshot) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Please select a delivery address before confirming checkout');
    }

    if (!session.delivery_method) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Please select a delivery method before confirming checkout');
    }

    const items = parseJson(session.items_snapshot, []);
    if (!Array.isArray(items) || !items.length) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Checkout session has no items');
    }

    const invalidItems = items.filter(item => !item.product_id || !item.seller_id || parseInt(item.quantity, 10) <= 0);
    if (invalidItems.length) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Checkout session contains invalid items');
    }

    const productIds = [...new Set(items.map(item => item.product_id))];
    const productsRes = await client.query(
      `SELECT id, stock_quantity, is_active, is_deleted
       FROM products
       WHERE id = ANY($1::uuid[])
       FOR UPDATE`,
      [productIds]
    );

    const productMap = new Map(productsRes.rows.map(product => [product.id, product]));
    const unavailable = [];

    for (const item of items) {
      const product = productMap.get(item.product_id);
      const requested = parseInt(item.quantity, 10);

      if (!product || product.is_deleted || product.is_active === false) {
        unavailable.push({
          productId: item.product_id,
          name: item.name,
          reason: 'unavailable',
        });
      } else if (parseInt(product.stock_quantity || 0, 10) < requested) {
        unavailable.push({
          productId: item.product_id,
          name: item.name,
          requested,
          available: parseInt(product.stock_quantity || 0, 10),
        });
      }
    }

    if (unavailable.length) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'Some items are no longer available in the requested quantity', {
        items: unavailable,
      });
    }

    const address = parseJson(session.address_snapshot, {});
    const subtotal = money(session.subtotal);
    const couponDiscount = money(session.coupon_discount);
    const shippingFee = money(session.shipping_fee);
    const totalAmount = money(session.total || (subtotal - couponDiscount + shippingFee));
    const chosenPaymentMethod = paymentMethod || session.payment_method || 'paystack';
    if (chosenPaymentMethod !== 'paystack') {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Unsupported payment method');
    }

    const orderStatus = 'awaiting_payment';
const sellerDeliveries = await fetchSellerDeliveries(client, sessionId);
const vendors = Object.values(groupBySeller(items)).map(v => {
  const d = sellerDeliveries.get(v.sellerId);
  if (!d) throw Object.assign(new Error(`Missing delivery selection for seller ${v.sellerId}`), { code: 'MISSING_DELIVERY' });
  return { ...v, shippingFee: parseFloat(d.fee), deliveryMethod: d.method, deliveryProvider: d.provider_id };
});
const orderStoreId = vendors.length === 1 ? vendors[0].storeId : null;

    const orderRes = await client.query(
      `INSERT INTO orders
         (buyer_id, total_amount, status, shipping_name, shipping_address,
          shipping_city, shipping_state, shipping_zip, shipping_country,
          shipping_phone, payment_method, payment_status, notes, store_id,
          checkout_session_id, address_snapshot, subtotal, coupon_discount,
          created_at, updated_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unpaid',$12,$13,$14,$15,$16,$17,NOW(),NOW())
       RETURNING *`,
      [
        userId,
        totalAmount,
        orderStatus,
        address.full_name || null,
        buildShippingAddress(address),
        address.city || null,
        address.state || null,
        address.postal_code || null,
        address.country || null,
        address.phone || null,
        chosenPaymentMethod,
        notes || address.delivery_instructions || null,
        orderStoreId,
        sessionId,
        JSON.stringify(address),
        subtotal,
        couponDiscount,
      ]
    );

    
    const order = orderRes.rows[0];
    const seqRes = await client.query(`SELECT nextval('order_number_seq') n`);
    const orderNumber = `MMX-${seqRes.rows[0].n}`;
    await client.query(`UPDATE orders SET order_number=$1 WHERE id=$2`, [orderNumber, order.id]);

    const vendorSummaries = [];

    for (const vendor of vendors) {
      const vendorOrderRes = await client.query(
        `INSERT INTO vendor_orders
           (order_id, seller_id, store_id, status, delivery_method,
            delivery_provider, shipping_fee, subtotal, notes, created_at, updated_at)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,NOW(),NOW())
         RETURNING *`,
        [
          order.id,
          vendor.sellerId,
          vendor.storeId,
          vendor.deliveryMethod,
          vendor.deliveryProvider || null,
          vendor.shippingFee,
          vendor.subtotal,
          notes,
        ]
      );

      const vendorOrder = vendorOrderRes.rows[0];
      vendorSummaries.push(vendorOrder);

   const suffix = String.fromCharCode(65 + vendors.indexOf(vendor));
   await client.query(`UPDATE vendor_orders SET suborder_number=$1 WHERE id=$2`, [`${orderNumber}-${suffix}`, vendorOrder.id]);

      for (const item of vendor.items) {
        const itemTotal = money(item.price * item.quantity);
        const itemShare = vendor.subtotal > 0 ? itemTotal / vendor.subtotal : 0;
        const itemShipping = money(vendor.shippingFee * itemShare);

        console.log('Saving order item specifications', {
          orderId: order.id,
          productId: item.product_id,
          color: item.color || null,
          size: item.size || null,
        });
        console.log('ORDER ITEM SPECS', { color: item.color || null, size: item.size || null });
        await client.query(
          `INSERT INTO order_items
             (order_id, vendor_order_id, product_id, seller_id, store_id,
              quantity, price_at_purchase, product_snapshot, unit_price,
              total_price, shipping_amount, color, size, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11,$12,NOW())`,
          [
            order.id,
            vendorOrder.id,
            item.product_id,
            vendor.sellerId,
            item.store_id || vendor.storeId || null,
            item.quantity,
            item.price,
            JSON.stringify({
              product_id: item.product_id,
              name: item.name,
              image: item.image || item.main_image_url || null,
              price: item.price,
              seller_id: item.seller_id,
              store_id: item.store_id || null,
              color: item.color || null,
              size: item.size || null,
            }),
            itemTotal,
            itemShipping,
            item.color || null,
            item.size || null,
          ]
        );

        await client.query(
          `UPDATE products
           SET stock_quantity = stock_quantity - $1,
               updated_at = NOW()
           WHERE id = $2`,
          [item.quantity, item.product_id]
        );
      }

      // Create a seller notification for the new vendor order
      const buyerResult = await client.query(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [userId]
      );
      const buyerName = buyerResult.rows.length
        ? `${buyerResult.rows[0].first_name || ''} ${buyerResult.rows[0].last_name || ''}`.trim()
        : 'a buyer';

      const title = 'New Order Received';
      const message = `You have a new order from ${buyerName} for ${vendor.items.length} item${vendor.items.length === 1 ? '' : 's'}.`;
     await client.query(
  `INSERT INTO notifications
     (user_id, title, message, type, link, is_read, is_deleted, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5, FALSE, FALSE, NOW(), NOW())`,
  [
    vendor.sellerId,
    title,
    message,
    'order',
    '/sellers/sellers%20order.html',
  ]
);
    // controllers/order_creation.controller.js — inside confirmCheckout, after the notifications INSERT in the vendor loop:
      notifySeller(vendor.sellerId, 'newOrder', {
     orderId: order.id,
     buyerName,
     amount: vendor.subtotal,
      items: vendor.items.map(i => i.name).join(', ')
    }).catch(err => console.error('EMAIL FAIL:', err));
    }

    await client.query(
      `UPDATE checkout_sessions
       SET order_id = $1,
           payment_method = $2,
           payment_status = 'unpaid',
           status = 'completed',
           updated_at = NOW()
       WHERE id = $3`,
      [order.id, chosenPaymentMethod, sessionId]
    );

    await clearCart(client, userId);
    await client.query('COMMIT');

    notifyBuyer(userId, 'orderConfirmed', {
  orderId: order.id,
  items: items.map(i => i.name).join(', '),
  total: totalAmount,
  estimatedDelivery: session.estimated_delivery || null
}).catch(() => {});

    return sendSuccess(res, 201, 'Checkout confirmed and order created', {
      order: {
        id: order.id,
        orderNumber: order.order_number || null,
        status: order.status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        subtotal,
        shippingFee,
        couponDiscount,
        totalAmount,
        createdAt: order.created_at,
      },
      vendorOrders: vendorSummaries.map(vendor => ({
        id: vendor.id,
        sellerId: vendor.seller_id,
        storeId: vendor.store_id,
        status: vendor.status,
        subtotal: money(vendor.subtotal),
        shippingFee: money(vendor.shipping_fee),
      })),
    });
 } catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  if (err.code === 'MISSING_DELIVERY') return sendError(res, 400, err.message);
  console.error('confirmCheckout error:', err);
  return sendError(res, 500, 'Error confirming checkout', err.message);
}
};

module.exports = {
  confirmCheckout,
};
