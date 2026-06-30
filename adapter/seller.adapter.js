/**
 * Seller Adapter — seller-managed delivery
 * Reads vendor_shipping_settings to build a quote.
 * Interface: getQuote(sessionId, items, address, sellerId) → QuoteResult | null
 */

const db = require('../config/db');

async function getQuote(sessionId, items, address, sellerId) {
  try {
    const settingsRes = await db.query(
      `SELECT * FROM vendor_shipping_settings
       WHERE seller_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sellerId]
    );

    console.log('[seller.adapter] raw settings row for', sellerId, ':', settingsRes.rows[0]);

// adapter/seller.adapter.js — getQuote()
if (!settingsRes.rows.length) {
  console.warn('[seller.adapter] no vendor_shipping_settings row for seller', sellerId);
  return {
    provider: 'seller',
    providerId: `seller-${sellerId}`,
    providerLabel: 'Standard Delivery',
    sellerId,
    fee: 1500, // sensible platform default
    isFreeShipping: false,
    estimatedDelivery: new Date(Date.now() + 5*86400000).toISOString().split('T')[0],
    estimatedDays: '3–5 business days',
    quoteReference: `seller-${sellerId}-default-${Date.now()}`,
    rawSettings: null,
  };
}

    const s = settingsRes.rows[0];
    if (s.is_active === false) {
      console.warn('[seller.adapter] settings inactive for seller', sellerId);
      return null;
    }

    // Subtotal for this seller's items only
    const sellerItems = items.filter(i => i.seller_id === sellerId);
    const subtotal = sellerItems.reduce(
      (sum, i) => sum + (parseFloat(i.price) * i.quantity),
      0
    );

    // Postgres NUMERIC columns come back as strings — parse defensively,
    // and treat 0/empty/null as "no free-shipping threshold set"
    const baseFee   = parseFloat(s.base_fee) || 0;
    const freeAbove = s.free_above !== null && s.free_above !== undefined && parseFloat(s.free_above) > 0
      ? parseFloat(s.free_above)
      : null;

    const isFreeShipping = freeAbove !== null && subtotal >= freeAbove;
    const fee = isFreeShipping ? 0 : baseFee;

    const minDays = s.min_days || 1;
    const maxDays = s.max_days || 5;
    const etaDate = new Date();
    etaDate.setDate(etaDate.getDate() + maxDays);

    const quote = {
      provider:          'seller',
      providerId:        `seller-${sellerId}`,
      providerLabel:      'Seller Delivery',
      sellerId,
      fee,
      isFreeShipping,
      estimatedDelivery: etaDate.toISOString().split('T')[0],
      estimatedDays:     `${minDays}–${maxDays} business days`,
      notes:             s.notes || null,
      quoteReference:    `seller-${sellerId}-${Date.now()}`,
      rawSettings:       s,
    };

    console.log('[seller.adapter] computed quote for', sellerId, ':', {
      baseFee, freeAbove, subtotal, isFreeShipping, fee
    });

    return quote;
  } catch (err) {
    console.error('[seller.adapter] getQuote error for', sellerId, ':', err.message);
    return null;
  }
}

module.exports = { getQuote };