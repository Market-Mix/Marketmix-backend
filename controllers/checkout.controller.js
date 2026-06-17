const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Pull live cart items for the authenticated user */
async function fetchCartItems(userId) {
  const cartRes = await db.query(
    `SELECT id FROM cart
     WHERE user_id = $1 AND is_active = true AND is_deleted = false
     LIMIT 1`,
    [userId]
  );
  if (!cartRes.rows.length) return [];

  const cartId = cartRes.rows[0].id;

  const itemsRes = await db.query(
    `SELECT
       ci.id            AS cart_item_id,
         ci.color,
         ci.size,
       ci.product_id,
       ci.quantity,
       p.name,
       p.price,
       p.stock_quantity,
       p.main_image_url,
       p.seller_id,
       p.weight_kg,
       p.store_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id = $1
       AND p.is_active  = true
       AND p.is_deleted = false`,
    [cartId]
  );
  return itemsRes.rows;
}

/** Compute subtotal from items snapshot */
function computeSubtotal(items) {
  return items.reduce(
    (sum, it) => sum + parseFloat(it.price) * parseInt(it.quantity),
    0
  );
}

/** Simple cart hash — detects if cart changed between sessions */
function hashItems(items) {
  return items
    .map(i => `${i.product_id}:${i.quantity}`)
    .sort()
    .join('|');
}

// ─── CREATE OR RESUME checkout session ──────────────────────────────────────

/**
 * POST /api/checkout/session
 *
 * Creates a new checkout session from the buyer's current cart,
 * OR resumes an existing non-expired session if the cart hasn't changed.
 */
const createOrResumeSession = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Load current cart items
    const cartItems = await fetchCartItems(userId);

    if (!cartItems.length) {
      return sendError(res, 400, 'Your cart is empty');
    }

    // 2. Validate stock for every item
    const outOfStock = cartItems.filter(
      it => it.stock_quantity < it.quantity
    );
    if (outOfStock.length) {
      return sendError(res, 409, 'Some items have insufficient stock', {
        items: outOfStock.map(it => ({
          productId: it.product_id,
          name: it.name,
          requested: it.quantity,
          available: it.stock_quantity,
        })),
      });
    }

    const cartHash   = hashItems(cartItems);
    const subtotal   = computeSubtotal(cartItems);

    // Snapshot stored in the session (prices locked at this moment)
    const snapshot = cartItems.map(it => ({
      cart_item_id: it.cart_item_id,
      product_id:   it.product_id,
      seller_id:    it.seller_id,
      store_id:     it.store_id   || null,
      name:         it.name,
      price:        parseFloat(it.price),
      quantity:     parseInt(it.quantity),
      color:        it.color || null,
      size:         it.size || null,
      weight_kg:    parseFloat(it.weight_kg) || 0.5,
      image:        it.main_image_url || null,
    }));

    // Temporary verification log
    if (snapshot.length) console.log('CHECKOUT SNAPSHOT ITEM', snapshot[0]);

    // 3. Try to resume an existing valid session with the same cart
    const existingRes = await db.query(
      `SELECT id, status, address_id, delivery_method,
              shipping_fee, coupon_code, coupon_discount,
              subtotal, total, payment_method, payment_status,
              address_snapshot, expires_at
       FROM checkout_sessions
       WHERE user_id   = $1
         AND status    NOT IN ('completed', 'expired', 'abandoned')
         AND expires_at > NOW()
         AND cart_hash = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, cartHash]
    );

    if (existingRes.rows.length) {
      const session = existingRes.rows[0];

      // Extend expiry by 30 min on resume
      await db.query(
        `UPDATE checkout_sessions
         SET expires_at = NOW() + INTERVAL '30 minutes',
             updated_at = NOW()
         WHERE id = $1`,
        [session.id]
      );

      return sendSuccess(res, 200, 'Checkout session resumed', {
        session: formatSession(session),
        items:   snapshot,
        subtotal,
        resumed: true,
      });
    }

    // 4. Expire any stale sessions for this user
    await db.query(
      `UPDATE checkout_sessions
       SET status = 'abandoned', updated_at = NOW()
       WHERE user_id = $1
         AND status NOT IN ('completed', 'expired', 'abandoned')`,
      [userId]
    );

    // 5. Create fresh session
    const newSession = await db.query(
      `INSERT INTO checkout_sessions
         (user_id, status, items_snapshot, cart_hash, subtotal, total, expires_at)
       VALUES ($1, 'pending', $2, $3, $4, $4, NOW() + INTERVAL '30 minutes')
       RETURNING id, status, subtotal, total, expires_at, created_at`,
      [userId, JSON.stringify(snapshot), cartHash, subtotal]
    );

    return sendSuccess(res, 201, 'Checkout session created', {
      session: formatSession(newSession.rows[0]),
      items:   snapshot,
      subtotal,
      resumed: false,
    });

  } catch (err) {
    console.error('createOrResumeSession error:', err);
    return sendError(res, 500, 'Error creating checkout session', err.message);
  }
};

// ─── GET session ─────────────────────────────────────────────────────────────

/**
 * GET /api/checkout/session/:sessionId
 */
const getSession = async (req, res) => {
  try {
    const userId    = req.user.id;
    const sessionId = req.params.sessionId;

    const result = await db.query(
      `SELECT cs.*,
              a.address_line1, a.address_line2, a.city, a.state,
              a.country, a.postal_code, a.full_name AS addr_name,
              a.phone AS addr_phone, a.delivery_instructions
       FROM checkout_sessions cs
       LEFT JOIN addresses a ON a.id = cs.address_id
       WHERE cs.id = $1 AND cs.user_id = $2`,
      [sessionId, userId]
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'Checkout session not found');
    }



    
    const session = result.rows[0];

    if (session.expires_at < new Date()) {
      await db.query(
        `UPDATE checkout_sessions SET status='expired', updated_at=NOW()
         WHERE id=$1`,
        [sessionId]
      );
      return sendError(res, 410, 'Checkout session has expired. Please start again.');
    }

    return sendSuccess(res, 200, 'Session fetched', {
      session: formatSession(session),
      items:   session.items_snapshot,
    });

  } catch (err) {
    console.error('getSession error:', err);
    return sendError(res, 500, 'Error fetching session', err.message);
  }
};

// ─── APPLY COUPON ────────────────────────────────────────────────────────────

/**
 * POST /api/checkout/session/:sessionId/coupon
 * Body: { code }
 */
const applyCoupon = async (req, res) => {
  try {
    const userId    = req.user.id;
    const sessionId = req.params.sessionId;
    const { code }  = req.body;

    if (!code || !code.trim()) {
      return sendError(res, 400, 'Coupon code is required');
    }

    const session = await requireActiveSession(sessionId, userId);
    if (!session) {
      return sendError(res, 404, 'Session not found or expired');
    }

    // Look up coupon
    const couponRes = await db.query(
      `SELECT * FROM coupons
       WHERE UPPER(code) = UPPER($1)
         AND is_active = true
       LIMIT 1`,
      [code.trim()]
    );

    console.log('Coupon found:', couponRes.rows[0]);
    console.log('Session subtotal:', session.subtotal);

    if (!couponRes.rows.length) {
      return sendError(res, 404, 'Invalid coupon code');
    }

    const coupon = couponRes.rows[0];

    if (coupon.expiry_date && new Date() > new Date(coupon.expiry_date)) {
      return sendError(res, 400, 'This coupon has expired');
    }
    if (coupon.usage_limit > 0 && coupon.used_count >= coupon.usage_limit) {
      return sendError(res, 400, 'This coupon has reached its usage limit');
    }

    const subtotal       = parseFloat(session.subtotal);
    const discountPct    = parseFloat(coupon.discount_percent || 0);
    const couponDiscount = parseFloat(
      ((subtotal * discountPct) / 100).toFixed(2)
    );
    const shippingFee    = parseFloat(session.shipping_fee || 0);
    const newTotal       = Math.max(
      0,
      subtotal - couponDiscount + shippingFee
    );

    console.log('discount%:', discountPct, 'discount amount:', couponDiscount, 'newTotal:', newTotal);

    await db.query(
      `UPDATE checkout_sessions
       SET coupon_code     = $1,
           coupon_discount = $2,
           total           = $3,
           updated_at      = NOW()
       WHERE id = $4`,
      [code.trim().toUpperCase(), couponDiscount, newTotal, sessionId]
    );

    return sendSuccess(res, 200, 'Coupon applied', {
      couponCode:      code.trim().toUpperCase(),
      discountPercent: discountPct,
      couponDiscount,
      subtotal,
      shippingFee,
      total:           newTotal,
    });

  } catch (err) {
    console.error('applyCoupon error:', err);
    return sendError(res, 500, 'Error applying coupon', err.message);
  }
};

/**
 * DELETE /api/checkout/session/:sessionId/coupon
 */
const removeCoupon = async (req, res) => {
  try {
    const userId    = req.user.id;
    const sessionId = req.params.sessionId;

    const session = await requireActiveSession(sessionId, userId);
    if (!session) return sendError(res, 404, 'Session not found or expired');

    const shippingFee = parseFloat(session.shipping_fee || 0);
    const newTotal    = parseFloat(session.subtotal) + shippingFee;

    await db.query(
      `UPDATE checkout_sessions
       SET coupon_code     = NULL,
           coupon_discount = 0,
           total           = $1,
           updated_at      = NOW()
       WHERE id = $2`,
      [newTotal, sessionId]
    );

    return sendSuccess(res, 200, 'Coupon removed', { total: newTotal });
  } catch (err) {
    console.error('removeCoupon error:', err);
    return sendError(res, 500, 'Error removing coupon', err.message);
  }
};

// ─── shared helpers ──────────────────────────────────────────────────────────

async function requireActiveSession(sessionId, userId) {
  const r = await db.query(
    `SELECT * FROM checkout_sessions
     WHERE id = $1
       AND user_id = $2
       AND status NOT IN ('completed', 'expired', 'abandoned')
       AND expires_at > NOW()`,
    [sessionId, userId]
  );
  return r.rows[0] || null;
}

function formatSession(s) {
  return {
    id:              s.id,
    status:          s.status,
    subtotal:        parseFloat(s.subtotal || 0),
    shippingFee:     parseFloat(s.shipping_fee || 0),
    couponCode:      s.coupon_code   || null,
    couponDiscount:  parseFloat(s.coupon_discount || 0),
    total:           parseFloat(s.total || 0),
    deliveryMethod:  s.delivery_method  || null,
    deliveryProvider:s.delivery_provider || null,
    estimatedDelivery: s.estimated_delivery || null,
    paymentMethod:   s.payment_method  || null,
    paymentStatus:   s.payment_status  || 'unpaid',
    addressId:       s.address_id      || null,
    orderId:         s.order_id        || null,
    expiresAt:       s.expires_at,
    createdAt:       s.created_at,
  };
}

module.exports = {
  createOrResumeSession,
  getSession,
  applyCoupon,
  removeCoupon,
  // shared
  requireActiveSession,
  formatSession,
};
