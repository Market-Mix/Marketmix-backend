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
    const userId = req.user.id;
    const session = await _getSession(sessionId, userId);
    if (!session) return sendError(res, 404, 'Checkout session not found');
    if (!session.address_id) return sendError(res, 400, 'Please set a delivery address before fetching delivery options');

    const addrRes = await db.query(`SELECT * FROM addresses WHERE id = $1`, [session.address_id]);
    if (!addrRes.rows.length) return sendError(res, 404, 'Delivery address not found');
    const address = addrRes.rows[0];

    const items = await _getSessionItems(sessionId, session);
    if (!items.length) return sendError(res, 400, 'No items found in session');

    // controllers/checkout_delivery.controller.js — inside getDeliveryOptions, BEFORE the sellerIds line
const quotes = await logistics.getDeliveryOptions(sessionId, items, address);

    // controllers/checkout_delivery.controller.js — inside getDeliveryOptions, after quotes are fetched

const sellerIds = [...new Set(items.map(i => i.seller_id).filter(Boolean))];
const namesRes = await db.query(
  `SELECT u.id,
          COALESCE(s.business_name, sp.business_name, u.first_name || ' ' || u.last_name) AS name
   FROM users u
   LEFT JOIN seller_profiles sp ON sp.user_id = u.id
   LEFT JOIN stores s ON s.user_id = u.id AND s.store_number = 1
   WHERE u.id = ANY($1::uuid[])`,
  [sellerIds]
);
const sellerNames = Object.fromEntries(namesRes.rows.map(r => [r.id, r.name]));

const quotesBySeller = quotes.reduce((acc, q) => {
  const sid = q.sellerId || 'marketmix';
  (acc[sid] = acc[sid] || []).push(q);
  return acc;
}, {});

return sendSuccess(res, 200, 'Delivery options fetched', {
  quotesBySeller, all: quotes, address, sellerNames
});

  } catch (err) {
    console.error('getDeliveryOptions error:', err);
    return sendError(res, 500, 'Error fetching delivery options', err.message);
  }
};



// ── POST apply delivery choice ────────────────────────────────────────────────
const selectDelivery = async (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.id;
  const { seller_id, method, provider_id } = req.body;
  if (!seller_id || !method || !provider_id) {
    return sendError(res, 400, 'seller_id, method and provider_id are required');
  }
  const session = await _getSession(sessionId, userId);
  if (!session) return sendError(res, 404, 'Checkout session not found');

  const updated = await logistics.applyDeliveryForSeller(session, seller_id, method, provider_id);
  const all = await db.query(
    `SELECT seller_id, method, provider_id, fee FROM checkout_session_deliveries WHERE checkout_session_id=$1`,
    [sessionId]
  );
  return sendSuccess(res, 200, 'Delivery method selected', {
    session: _sanitizeSession(updated.session),
    deliveries: all.rows,
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _getSession(sessionId, userId) {
  const res = await db.query(
    `SELECT * FROM checkout_sessions
     WHERE id = $1
       AND user_id = $2
       AND status NOT IN ('completed', 'expired', 'abandoned')
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId, userId]
  );
  return res.rows[0] || null;
}

async function _getSessionItems(sessionId, session) {
  const snapshot = typeof session.items_snapshot === 'string'
    ? JSON.parse(session.items_snapshot)
    : session.items_snapshot;

  return Array.isArray(snapshot) ? snapshot : [];
}

function _sanitizeSession(s) {
  return {
    id:               s.id,
    status:           s.status,
    subtotal:         parseFloat(s.subtotal || s.total_amount || 0),
    shippingFee:      parseFloat(s.shipping_fee || 0),
    discountAmount:   parseFloat(s.coupon_discount || s.discount_amount || 0),
    totalAmount:      parseFloat(s.total || s.total_amount || 0),
    deliveryMethod:   s.delivery_method,
    deliveryProvider: s.delivery_provider,
    estimatedDelivery: s.estimated_delivery,
  };
}

module.exports = { getDeliveryOptions, selectDelivery };
