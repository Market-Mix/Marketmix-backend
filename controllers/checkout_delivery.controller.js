/**
 * Delivery Controller — checkout delivery step
 *
 * GET  /api/checkout/session/:sessionId/delivery/options  — fetch quotes
 * POST /api/checkout/session/:sessionId/delivery          — apply choice
 */

const db       = require('../config/db');
const logistics = require('../services/logistics.service');
const { sendSuccess, sendError } = require('../utils/response');

// ── GET delivery options ──────────────────────────────────────────────────────
const getDeliveryOptions = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId        = req.user.id;

    const session = await _getSession(sessionId, userId);
    if (!session) return sendError(res, 404, 'Checkout session not found');

    if (!session.address_id) {
      return sendError(res, 400, 'Please set a delivery address before fetching delivery options');
    }

    // Fetch address
    const addrRes = await db.query(`SELECT * FROM addresses WHERE id = $1`, [session.address_id]);
    if (!addrRes.rows.length) return sendError(res, 404, 'Delivery address not found');
    const address = addrRes.rows[0];

    // Fetch cart / session items
    const items = await _getSessionItems(sessionId, session);

    if (!items.length) return sendError(res, 400, 'No items found in session');

    // Get quotes from logistics service
    const quotes = await logistics.getDeliveryOptions(sessionId, items, address);

    // Group for cleaner frontend consumption
    const sellerOptions   = quotes.filter(q => q.provider === 'seller');
    const marketmixOptions = quotes.filter(q => q.provider === 'marketmix');

    return sendSuccess(res, 200, 'Delivery options fetched', {
      sellerDelivery:    sellerOptions,
      marketmixDelivery: marketmixOptions,
      all:               quotes,
      address,
    });
  } catch (err) {
    console.error('getDeliveryOptions error:', err);
    return sendError(res, 500, 'Error fetching delivery options', err.message);
  }
};

// ── POST apply delivery choice ────────────────────────────────────────────────
const selectDelivery = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId        = req.user.id;
    const { method, provider_id } = req.body;

    if (!method || !provider_id) {
      return sendError(res, 400, 'method and provider_id are required');
    }
    if (!['seller', 'marketmix'].includes(method)) {
      return sendError(res, 400, 'method must be "seller" or "marketmix"');
    }

    const session = await _getSession(sessionId, userId);
    if (!session) return sendError(res, 404, 'Checkout session not found');

    if (!session.address_id) {
      return sendError(res, 400, 'Please set a delivery address first');
    }

    // If no quotes cached yet, regenerate
    const cached = await db.query(
      `SELECT id FROM delivery_quotes WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );

    if (!cached.rows.length) {
      const addrRes = await db.query(`SELECT * FROM addresses WHERE id = $1`, [session.address_id]);
      const items   = await _getSessionItems(sessionId, session);
      await logistics.getDeliveryOptions(sessionId, items, addrRes.rows[0] || {});
    }

    // Apply the chosen delivery
    const updatedSession = await logistics.applyDelivery(session, method, provider_id);

    return sendSuccess(res, 200, 'Delivery method selected', {
      session: _sanitizeSession(updatedSession),
    });
  } catch (err) {
    console.error('selectDelivery error:', err);
    return sendError(res, 500, 'Error selecting delivery method', err.message);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _getSession(sessionId, userId) {
  const res = await db.query(
    `SELECT * FROM checkout_sessions WHERE id = $1 AND user_id = $2 AND is_active = true LIMIT 1`,
    [sessionId, userId]
  );
  return res.rows[0] || null;
}

async function _getSessionItems(sessionId, session) {
  // Try vendor_orders first (created during session init)
  const voRes = await db.query(
    `SELECT vo.seller_id, vo.subtotal AS price, 1 AS quantity
     FROM vendor_orders vo WHERE vo.session_id = $1`,
    [sessionId]
  );

  if (voRes.rows.length) return voRes.rows;

  // Fallback: cart items joined with products
  const cartRes = await db.query(
    `SELECT ci.product_id, ci.quantity, p.price, p.seller_id
     FROM cart_items ci
     JOIN cart c ON ci.cart_id = c.id
     JOIN products p ON ci.product_id = p.id
     WHERE c.user_id = $1 AND p.is_active = true AND p.is_deleted = false`,
    [session.user_id]
  );

  return cartRes.rows;
}

function _sanitizeSession(s) {
  return {
    id:               s.id,
    status:           s.status,
    subtotal:         parseFloat(s.subtotal || s.total_amount || 0),
    shippingFee:      parseFloat(s.shipping_fee || 0),
    discountAmount:   parseFloat(s.discount_amount || 0),
    totalAmount:      parseFloat(s.total_amount || 0),
    deliveryMethod:   s.delivery_method,
    deliveryProvider: s.delivery_provider,
    estimatedDelivery: s.estimated_delivery,
  };
}

module.exports = { getDeliveryOptions, selectDelivery };