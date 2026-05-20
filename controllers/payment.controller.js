/**
 * Payment Controller
 * Handles: initiate, verify, webhooks, refunds, COD confirmation
 *
 * Routes (see payment.routes.js):
 *   GET  /api/payments/methods
 *   POST /api/payments/initiate
 *   POST /api/payments/verify
 *   POST /api/payments/paystack/webhook
 *   POST /api/payments/flutterwave/webhook
 *   POST /api/payments/cod/confirm       (seller/delivery confirms COD)
 *   POST /api/payments/refund            (admin only)
 *   GET  /api/payments/paystack/callback
 *   GET  /api/payments/flutterwave/callback
 */

const db         = require('../config/db');
const marketpay  = require('../services/marketpay.service');
const { sendSuccess, sendError } = require('../utils/response');

// ── GET /api/payments/methods ─────────────────────────────────────────────────
const getPaymentMethods = (req, res) => {
  const methods = marketpay.getAvailableMethods();
  return sendSuccess(res, 200, 'Payment methods fetched', { methods });
};

// ── POST /api/payments/initiate ───────────────────────────────────────────────
/**
 * Called from frontend when buyer confirms order.
 * 1. Validates checkout session
 * 2. Creates master_order + vendor_orders (for COD immediately; else pending)
 * 3. Calls MarketPay to get payment link / COD reference
 * 4. Saves payment_transaction record
 * 5. Returns payment URL or COD confirmation
 */
const initiatePayment = async (req, res) => {
  const client = await db.pool.connect();
  try {
    const userId    = req.user.id;
    const { sessionId, method, callbackUrl } = req.body;

    if (!sessionId || !method) {
      return sendError(res, 400, 'sessionId and method are required');
    }

    // 1. Load and validate session
    const sessionRes = await client.query(
      `SELECT cs.*, u.email, u.first_name, u.last_name, u.phone
       FROM checkout_sessions cs
       JOIN users u ON u.id = cs.user_id
       WHERE cs.id = $1 AND cs.user_id = $2
         AND cs.status NOT IN ('completed', 'expired', 'abandoned')
         AND cs.expires_at > NOW()`,
      [sessionId, userId]
    );

    if (!sessionRes.rows.length) {
      return sendError(res, 404, 'Checkout session not found or expired');
    }

    const session = sessionRes.rows[0];

    if (!session.address_id) {
      return sendError(res, 400, 'Please select a delivery address before payment');
    }
    if (!session.delivery_method) {
      return sendError(res, 400, 'Please select a delivery method before payment');
    }

    const totalAmount = parseFloat(session.total_amount || session.total || 0);
    if (totalAmount <= 0) {
      return sendError(res, 400, 'Invalid order total');
    }

    await client.query('BEGIN');

    // 2. Create master order
    const orderStatus  = method === 'cod' ? 'pending' : 'awaiting_payment';
    const paymentStatus = method === 'cod' ? 'unpaid' : 'unpaid';

    
  const orderRes = await client.query(
  `INSERT INTO orders
     (buyer_id, checkout_session_id, status, payment_method,
      payment_status, subtotal, shipping_fee, discount_amount,
      total_amount, coupon_code, address_id, delivery_method,
      delivery_provider, estimated_delivery, notes, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
   RETURNING id, total_amount, status`,
  [
    userId, sessionId, orderStatus, method, paymentStatus,
    parseFloat(session.subtotal || 0),
    parseFloat(session.shipping_fee || 0),
    parseFloat(session.coupon_discount || 0),
    totalAmount,
    session.coupon_code || null,
    session.address_id,
    session.delivery_method,
    session.delivery_provider || null,
    session.estimated_delivery || null,
    session.notes || null,
  ]
);


    const order = orderRes.rows[0];

    // 3. Create vendor orders from items snapshot
    const items = session.items_snapshot || [];
    const vendorMap = {};
    for (const item of items) {
      const sid = item.seller_id;
      if (!vendorMap[sid]) vendorMap[sid] = { seller_id: sid, store_id: item.store_id || null, items: [], subtotal: 0 };
      vendorMap[sid].items.push(item);
      vendorMap[sid].subtotal += item.price * item.quantity;
    }

    for (const v of Object.values(vendorMap)) {
      const voRes = await client.query(
        `INSERT INTO vendor_orders
           (order_id, seller_id, store_id, status, subtotal, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [order.id, v.seller_id, v.store_id, 'pending', v.subtotal]
      );
      const voId = voRes.rows[0].id;

      for (const item of v.items) {
        await client.query(
          `INSERT INTO order_items
             (order_id, vendor_order_id, product_id, seller_id, store_id,
              quantity, price_at_purchase, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [order.id, voId, item.product_id, v.seller_id, v.store_id || null, item.quantity, item.price]
        );

        // Reserve stock
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity - $1
           WHERE id = $2 AND stock_quantity >= $1`,
          [item.quantity, item.product_id]
        );
      }
    }

    // 4. Initiate payment via MarketPay
    const payResult = await marketpay.initiatePayment(method, {
      orderId:     order.id,
      amount:      totalAmount,
      currency:    'NGN',
      email:       session.email,
      name:        `${session.first_name} ${session.last_name}`.trim(),
      phone:       session.phone,
      callbackUrl: callbackUrl || `${process.env.APP_BASE_URL}/api/payments/${method}/callback`,
      metadata:    { sessionId, userId },
    });

    // 5. Save payment transaction
   await client.query(
  `INSERT INTO payment_transactions
     (order_id, user_id, provider, provider_reference, provider_transaction_id,
      amount, currency, status, raw_response, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
  [
    order.id, userId, method,
    payResult.reference,
    payResult.transactionId || null,
    totalAmount, 'NGN', 'pending',
    JSON.stringify(payResult.raw || {}),
  ]
);

    // 6. Update session → payment_initiated
    await client.query(
      `UPDATE checkout_sessions
       SET order_id = $1, payment_method = $2, status = 'payment_initiated', updated_at = NOW()
       WHERE id = $3`,
      [order.id, method, sessionId]
    );

    await client.query('COMMIT');

    // 7. Clear buyer's cart (async, non-critical)
    _clearCart(userId).catch(e => console.warn('Cart clear failed:', e.message));

    const responseData = {
      orderId:   order.id,
      reference: payResult.reference,
      method,
      amount:    totalAmount,
    };

    if (method === 'cod') {
      responseData.message = 'Order placed. Pay on delivery.';
      responseData.orderStatus = 'pending';
    } else {
      responseData.paymentUrl      = payResult.authorizationUrl || payResult.paymentLink;
      responseData.accessCode      = payResult.accessCode;
      responseData.publicKey       = method === 'paystack'
        ? process.env.PAYSTACK_PUBLIC_KEY
        : process.env.FLUTTERWAVE_PUBLIC_KEY;
    }

    return sendSuccess(res, 201, 'Payment initiated', responseData);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('initiatePayment error:', err);
    return sendError(res, 500, 'Error initiating payment', err.message);
  } finally {
    client.release();
  }
};

// ── POST /api/payments/verify ─────────────────────────────────────────────────
const verifyPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reference, method, transactionId } = req.body;

    if (!reference || !method) {
      return sendError(res, 400, 'reference and method are required');
    }

    const result = await marketpay.verifyPayment(method, reference, transactionId);

    if (result.paymentStatus === 'paid') {
      await _fulfillOrder(reference, result);
    }

    return sendSuccess(res, 200, 'Payment verified', {
      reference,
      status:        result.status,
      paymentStatus: result.paymentStatus,
      amount:        result.amount,
      paidAt:        result.paidAt,
    });
  } catch (err) {
    console.error('verifyPayment error:', err);
    return sendError(res, 500, 'Error verifying payment', err.message);
  }
};

// ── POST /api/payments/paystack/webhook ───────────────────────────────────────
const paystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const valid     = marketpay.verifyWebhook('paystack', req.body, signature);

    if (!valid) {
      console.warn('Invalid Paystack webhook signature');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    // Acknowledge immediately (Paystack retries if no 200 within 20s)
    res.status(200).json({ received: true });

    const event = req.body;
    console.log(`📣 Paystack webhook: ${event.event}`);

    if (event.event === 'charge.success') {
      const tx = event.data;
      await _fulfillOrder(tx.reference, {
        paymentStatus:   'paid',
        amount:          tx.amount / 100,
        paidAt:          tx.paid_at,
        gatewayResponse: tx.gateway_response,
        channel:         tx.channel,
        raw:             tx,
      });
    }

    if (event.event === 'charge.failed') {
      await _markPaymentFailed(event.data.reference, 'paystack');
    }

  } catch (err) {
    console.error('paystackWebhook error:', err);
  }
};

// ── POST /api/payments/flutterwave/webhook ────────────────────────────────────
const flutterwaveWebhook = async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    const valid     = marketpay.verifyWebhook('flutterwave', req.body, signature);

    if (!valid) {
      console.warn('Invalid Flutterwave webhook signature');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    res.status(200).json({ received: true });

    const event = req.body;
    console.log(`📣 Flutterwave webhook: ${event.event}`);

    if (event.event === 'charge.completed' && event.data?.status === 'successful') {
      const tx = event.data;
      await _fulfillOrder(tx.tx_ref, {
        paymentStatus:   'paid',
        amount:          tx.amount,
        paidAt:          tx.created_at,
        gatewayResponse: tx.processor_response,
        channel:         tx.payment_type,
        transactionId:   String(tx.id),
        raw:             tx,
      });
    }

  } catch (err) {
    console.error('flutterwaveWebhook error:', err);
  }
};

// ── GET /api/payments/paystack/callback ───────────────────────────────────────
const paystackCallback = async (req, res) => {
  const { reference } = req.query;
  const frontendBase  = process.env.FRONTEND_URL || 'https://marketmix.vercel.app';

  try {
    if (!reference) {
      return res.redirect(`${frontendBase}/buyers/order-failed.html?reason=missing_reference`);
    }

    const result = await marketpay.verifyPayment('paystack', reference);

    if (result.paymentStatus === 'paid') {
      await _fulfillOrder(reference, result);
      // Look up order ID to redirect properly
      const txRow = await db.query(
        `SELECT order_id FROM payment_transactions WHERE reference = $1 LIMIT 1`,
        [reference]
      );
      const orderId = txRow.rows[0]?.order_id || '';
      return res.redirect(`${frontendBase}/buyers/order-success.html?orderId=${orderId}&ref=${reference}`);
    }

    return res.redirect(`${frontendBase}/buyers/order-failed.html?ref=${reference}&status=${result.status}`);
  } catch (err) {
    console.error('paystackCallback error:', err);
    return res.redirect(`${frontendBase}/buyers/order-failed.html?reason=verification_error`);
  }
};

// ── GET /api/payments/flutterwave/callback ────────────────────────────────────
const flutterwaveCallback = async (req, res) => {
  const { tx_ref, transaction_id, status } = req.query;
  const frontendBase = process.env.FRONTEND_URL || 'https://marketmix.vercel.app';

  try {
    if (status === 'cancelled') {
      return res.redirect(`${frontendBase}/buyers/order-failed.html?reason=cancelled`);
    }

    const result = await marketpay.verifyPayment('flutterwave', tx_ref, transaction_id);

    if (result.paymentStatus === 'paid') {
      await _fulfillOrder(tx_ref, result);
      const txRow = await db.query(
        `SELECT order_id FROM payment_transactions WHERE reference = $1 LIMIT 1`,
        [tx_ref]
      );
      const orderId = txRow.rows[0]?.order_id || '';
      return res.redirect(`${frontendBase}/buyers/order-success.html?orderId=${orderId}&ref=${tx_ref}`);
    }

    return res.redirect(`${frontendBase}/buyers/order-failed.html?ref=${tx_ref}&status=${result.status}`);
  } catch (err) {
    console.error('flutterwaveCallback error:', err);
    return res.redirect(`${frontendBase}/buyers/order-failed.html?reason=verification_error`);
  }
};

// ── POST /api/payments/cod/confirm ────────────────────────────────────────────
// Called by seller/delivery agent to confirm COD payment collected
const confirmCOD = async (req, res) => {
  try {
    const { orderId, reference } = req.body;
    const sellerId = req.user.id;

    if (!orderId) return sendError(res, 400, 'orderId is required');

    // Verify seller owns a vendor_order in this master order
    const ownerCheck = await db.query(
      `SELECT 1 FROM vendor_orders WHERE order_id = $1 AND seller_id = $2 LIMIT 1`,
      [orderId, sellerId]
    );
    if (!ownerCheck.rows.length) {
      return sendError(res, 403, 'Access denied to this order');
    }

    await db.query(
      `UPDATE orders SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );

    await db.query(
      `UPDATE payment_transactions SET status = 'success', updated_at = NOW()
       WHERE order_id = $1 AND provider = 'cod'`,
      [orderId]
    );

    return sendSuccess(res, 200, 'COD payment confirmed', { orderId });
  } catch (err) {
    console.error('confirmCOD error:', err);
    return sendError(res, 500, 'Error confirming COD', err.message);
  }
};

// ── POST /api/payments/refund ─────────────────────────────────────────────────
const processRefund = async (req, res) => {
  try {
    const { orderId, reason, amount } = req.body;

    const txRes = await db.query(
      `SELECT * FROM payment_transactions WHERE order_id = $1 AND status = 'success' LIMIT 1`,
      [orderId]
    );

    if (!txRes.rows.length) {
      return sendError(res, 404, 'No successful payment found for this order');
    }

    const tx = txRes.rows[0];
    const result = await marketpay.refundPayment(tx.provider, {
      reference:     tx.reference,
      transactionId: tx.provider_transaction_id,
      amount:        amount || tx.amount,
      reason,
    });

    await db.query(
      `UPDATE payment_transactions SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [tx.id]
    );
    await db.query(
      `UPDATE orders SET payment_status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    return sendSuccess(res, 200, 'Refund processed', result);
  } catch (err) {
    console.error('processRefund error:', err);
    return sendError(res, 500, 'Error processing refund', err.message);
  }
};

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _fulfillOrder(reference, payResult) {
  try {
    const txRes = await db.query(
      `SELECT * FROM payment_transactions WHERE reference = $1 LIMIT 1`,
      [reference]
    );
    if (!txRes.rows.length) {
      console.warn(`_fulfillOrder: no transaction found for reference ${reference}`);
      return;
    }

    const tx = txRes.rows[0];
    if (tx.status === 'success') return; // already fulfilled (idempotent)

    // Update transaction
    await db.query(
      `UPDATE payment_transactions
       SET status = 'success',
           provider_transaction_id = COALESCE($1, provider_transaction_id),
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [payResult.transactionId || null, tx.id]
    );

    // Update order
    await db.query(
      `UPDATE orders
       SET payment_status = 'paid',
           status = 'confirmed',
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND payment_status != 'paid'`,
      [tx.order_id]
    );

    // Update vendor orders
    await db.query(
      `UPDATE vendor_orders SET status = 'confirmed', updated_at = NOW()
       WHERE order_id = $1`,
      [tx.order_id]
    );

    console.log(`✅ Order ${tx.order_id} fulfilled — ref: ${reference}`);
  } catch (err) {
    console.error('_fulfillOrder error:', err);
  }
}

async function _markPaymentFailed(reference, provider) {
  try {
    await db.query(
      `UPDATE payment_transactions SET status = 'failed', updated_at = NOW() WHERE reference = $1`,
      [reference]
    );
    const txRes = await db.query(
      `SELECT order_id FROM payment_transactions WHERE reference = $1 LIMIT 1`,
      [reference]
    );
    if (txRes.rows.length) {
      await db.query(
        `UPDATE orders SET payment_status = 'failed', status = 'payment_failed', updated_at = NOW()
         WHERE id = $1`,
        [txRes.rows[0].order_id]
      );
    }
    console.log(`❌ Payment failed — ref: ${reference}`);
  } catch (err) {
    console.error('_markPaymentFailed error:', err);
  }
}

async function _clearCart(userId) {
  const cartRes = await db.query(
    `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
    [userId]
  );
  if (cartRes.rows.length) {
    await db.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartRes.rows[0].id]);
  }
}

module.exports = {
  getPaymentMethods,
  initiatePayment,
  verifyPayment,
  paystackWebhook,
  flutterwaveWebhook,
  paystackCallback,
  flutterwaveCallback,
  confirmCOD,
  processRefund,
};