const db = require('../config/db');
const sellerAdapter = require('../adapter/seller.adapter');
const marketmixAdapter = require('../adapter/marketmix.adapter');
const shipbubbleAdapter = require('../adapter/shipbubble.adapter');

async function getDeliveryOptions(sessionId, items, address) {
  const quotes = [];
  const sellerIds = [...new Set(items.map(i => i.seller_id).filter(Boolean))];

  for (const sellerId of sellerIds) {
    try {
      const q = await sellerAdapter.getQuote(sessionId, items, address, sellerId);
      if (q) quotes.push(q);
    } catch (e) { console.warn('[logistics] seller quote:', e.message); }
  }

 // services/logistics.service.js — replace the shipbubble loop
for (const sellerId of sellerIds) {
  try {
    const sbQuotes = await shipbubbleAdapter.getQuotes(sessionId, items, address, sellerId);
    console.log(`[logistics] shipbubble quotes for seller ${sellerId}:`, sbQuotes?.length, sbQuotes);
    if (sbQuotes?.length) quotes.push(...sbQuotes);
  } catch (e) {
    console.error('[logistics] shipbubble error for seller', sellerId, ':', e.message);
  }
}

  try {
    const mmQuotes = await marketmixAdapter.getQuotes(sessionId, items, address);
    if (Array.isArray(mmQuotes)) quotes.push(...mmQuotes);
  } catch (e) { console.warn('[logistics] marketmix quote:', e.message); }


  try { await _persistQuotes(sessionId, quotes); }
  catch (e) { console.warn('[logistics] persist quotes skipped:', e.message); }

  return quotes;
}

function toSafeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// services/logistics.service.js — applyDeliveryForSeller, simplify
async function applyDeliveryForSeller(session, sellerId, method, providerId, feeOverride) {
  const fee = parseFloat(feeOverride || 0);

  await db.query(
    `INSERT INTO checkout_session_deliveries (checkout_session_id, seller_id, method, provider_id, fee)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (checkout_session_id, seller_id) DO UPDATE SET
       method=$3, provider_id=$4, fee=$5, updated_at=NOW()`,
    [session.id, sellerId, method, providerId, fee]
  );

  const sum = await db.query(`SELECT COALESCE(SUM(fee),0) t FROM checkout_session_deliveries WHERE checkout_session_id=$1`, [session.id]);
  const shippingFee = parseFloat(sum.rows[0].t);
  const newTotal = parseFloat(session.subtotal||0) - parseFloat(session.coupon_discount||0) + shippingFee;

  const updated = await db.query(
    `UPDATE checkout_sessions SET shipping_fee=$1, total=$2, status='delivery_set', updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [shippingFee, newTotal, session.id]
  );
  return { session: updated.rows[0] };
}

async function _persistQuotes(sessionId, quotes) {
  try {
    await db.query(`DELETE FROM delivery_quotes WHERE checkout_session_id = $1`, [sessionId]);
  } catch (e) {
    console.warn('[logistics] persist skipped:', e.message);
    return;
  }

  for (const q of quotes) {
    try {
     // services/logistics.service.js — _persistQuotes()
await db.query(
  `INSERT INTO delivery_quotes
     (checkout_session_id, seller_id, provider, quote_reference, service_type,
      base_fee, insurance_fee, total_fee, currency, estimated_delivery)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT DO NOTHING`,
  [sessionId, q.sellerId || null, q.provider, q.quoteReference || null, q.serviceType || null,
   q.fee || 0, q.insuranceFee || 0, q.totalFee || q.fee || 0, q.currency || 'NGN', q.estimatedDelivery || null]
);
    } catch (e) { console.warn('[logistics] insert quote failed:', e.message); }
  }
}
module.exports = { getDeliveryOptions, applyDeliveryForSeller };