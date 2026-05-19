/**
 * Logistics Service — central adapter router
 *
 * Usage:
 *   const logistics = require('./logistics.service');
 *   const quotes = await logistics.getDeliveryOptions(sessionId, items, address);
 *   const chosen  = await logistics.applyDelivery(session, method, providerId);
 */

const db             = require('../config/db');
const sellerAdapter  = require('../adapter/seller.adapter');
const shipbubbleAdapter = require('../adapter/shipbubble.adapter');
const marketmixAdapter = require('../adapter/marketmix.adapter');

/**
 * Fetch all available delivery options for a checkout session.
 * Returns seller quote (if seller has shipping settings) +
 * all MarketMix provider quotes.
 *
 * @param {string} sessionId
 * @param {Array}  items     - vendor_order rows or cart items with seller_id, price, quantity
 * @param {Object} address   - buyer delivery address
 * @returns {Array<QuoteResult>}
 */
async function getDeliveryOptions(sessionId, items, address) {
  const quotes = [];

  // Collect unique seller IDs
  const sellerIds = [...new Set(items.map(i => i.seller_id).filter(Boolean))];

  // Seller quotes
  for (const sellerId of sellerIds) {
    const q = await sellerAdapter.getQuote(sessionId, items, address, sellerId);
    if (q) quotes.push(q);
  }

  // MarketMix quotes (all providers)
  const mmQuotes = await marketmixAdapter.getQuotes(sessionId, items, address);
  quotes.push(...mmQuotes);

  // Shipbubble quotes
  const sbQuotes = await shipbubbleAdapter.getQuote(sessionId, items, address);
  quotes.push(...sbQuotes);

  // Persist to delivery_quotes table
  await _persistQuotes(sessionId, quotes);

  return quotes;
}

/**
 * Apply a delivery choice to a checkout session.
 * Updates session: shipping_fee, total, delivery_method, delivery_provider,
 *                  estimated_delivery, status → 'delivery_set'
 *
 * @param {Object} session    - checkout_session row
 * @param {string} method     - 'seller' | 'marketmix'
 * @param {string} providerId - e.g. 'seller', 'shipbubble', 'kwik'
 * @returns {Object} updatedSession
 */
async function applyDelivery(session, method, providerId) {
  // Find persisted quote
  const quoteRes = await db.query(
    `SELECT * FROM delivery_quotes
     WHERE session_id = $1 AND provider = $2 AND provider_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [session.id, method, providerId]
  );

  if (!quoteRes.rows.length) {
    throw new Error(`No quote found for provider "${providerId}". Refresh delivery options.`);
  }

  const quote = quoteRes.rows[0];
  const shippingFee = parseFloat(quote.fee);
  const subtotal    = parseFloat(session.subtotal || session.total_amount || 0);
  const discount    = parseFloat(session.coupon_discount || session.discount_amount || 0);
  const newTotal    = subtotal - discount + shippingFee;

  const updated = await db.query(
    `UPDATE checkout_sessions SET
       delivery_method    = $1,
       delivery_provider  = $2,
       shipping_fee       = $3,
       total              = $4,
       estimated_delivery = $5,
       status             = 'delivery_set',
       updated_at         = NOW()
     WHERE id = $6
     RETURNING *`,
    [method, providerId, shippingFee, newTotal, quote.estimated_delivery, session.id]
  );

  // Mark quote as selected
  await db.query(
    `UPDATE delivery_quotes SET is_selected = true, updated_at = NOW()
     WHERE session_id = $1 AND provider = $2 AND provider_id = $3`,
    [session.id, method, providerId]
  );

  return updated.rows[0];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _persistQuotes(sessionId, quotes) {
  // Clear previous quotes for this session
  await db.query(`DELETE FROM delivery_quotes WHERE session_id = $1`, [sessionId]);

  for (const q of quotes) {
    await db.query(
      `INSERT INTO delivery_quotes
         (session_id, provider, provider_id, provider_label, fee,
          estimated_delivery, estimated_days, notes, quote_reference,
          raw_response, is_mock, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT DO NOTHING`,
      [
        sessionId,
        q.provider,
        q.providerId,
        q.providerLabel,
        q.fee,
        q.estimatedDelivery || null,
        q.estimatedDays     || null,
        q.notes             || null,
        q.quoteReference    || null,
        JSON.stringify(q.rawSettings || q.raw || {}),
        q.isMock ? true : false,
      ]
    );
  }
}

module.exports = { getDeliveryOptions, applyDelivery };
