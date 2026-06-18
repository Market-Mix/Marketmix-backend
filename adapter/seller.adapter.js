/**
 * Seller Adapter — seller-managed delivery
 * Reads vendor_shipping_settings to build a quote.
 * Interface: getQuote(sessionId, items, address, sellerId) → QuoteResult
 */

const db = require('../config/db');

/**
 * @param {string} sessionId
 * @param {Array}  items     - array of { seller_id, quantity, price }
 * @param {Object} address   - { state, city, country }
 * @param {string} sellerId  - specific seller to quote for
 * @returns {QuoteResult | null}
 */
async function getQuote(sessionId, items, address, sellerId) {
  try {
    const settingsRes = await db.query(
      `SELECT * FROM vendor_shipping_settings
       WHERE seller_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sellerId]
    );

    if (!settingsRes.rows.length) return null;

    const s = settingsRes.rows[0];
    if (s.is_active === false) return null;

    // Calculate subtotal for this seller's items
    const sellerItems = items.filter(i => i.seller_id === sellerId);
    const subtotal = sellerItems.reduce((sum, i) => sum + (parseFloat(i.price) * i.quantity), 0);

    // Free shipping threshold
    const isFreeShipping = s.free_above && subtotal >= parseFloat(s.free_above);
    const fee = isFreeShipping ? 0 : parseFloat(s.base_fee || 0);

    // Estimated delivery
    const minDays = s.min_days || 1;
    const maxDays = s.max_days || 5;
    const etaDate = new Date();
    etaDate.setDate(etaDate.getDate() + maxDays);

    return {
      provider:          'seller',
      providerId:        'seller',
      providerLabel:     'Seller Delivery',
      sellerId,
      fee,
      isFreeShipping,
      estimatedDelivery: etaDate.toISOString().split('T')[0],
      estimatedDays:     `${minDays}–${maxDays} business days`,
      notes:             s.notes || null,
      quoteReference:    `SELLER-${sellerId}-${Date.now()}`,
      rawSettings:       s,
    };

    // Quick debug — add this temporarily in seller.adapter.js getQuote()
console.log('[seller.adapter] settings for', sellerId, ':', {
  base_fee: s.base_fee,
  free_above: s.free_above,
  subtotal,
  isFreeShipping
});

  } catch (err) {
    console.error('[seller.adapter] getQuote error:', err.message);
    return null;
  }
}

module.exports = { getQuote };
