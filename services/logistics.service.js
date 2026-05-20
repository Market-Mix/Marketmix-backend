const db = require('../config/db');
const sellerAdapter = require('../adapter/seller.adapter');
const shipbubbleAdapter = require('../adapter/shipbubble.adapter');
const marketmixAdapter = require('../adapter/marketmix.adapter');

async function getDeliveryOptions(sessionId, items, address) {
  const quotes = [];
  const sellerIds = [...new Set(items.map(i => i.seller_id).filter(Boolean))];

  for (const sellerId of sellerIds) {
    try {
      const q = await sellerAdapter.getQuote(sessionId, items, address, sellerId);
      if (q) quotes.push(q);
    } catch (e) { console.warn('[logistics] seller quote:', e.message); }
  }

  try {
    const mmQuotes = await marketmixAdapter.getQuotes(sessionId, items, address);
    if (Array.isArray(mmQuotes)) quotes.push(...mmQuotes);
  } catch (e) { console.warn('[logistics] marketmix quote:', e.message); }

  try {
    const sbResult = await shipbubbleAdapter.getQuote(sessionId, items, address);
    if (Array.isArray(sbResult)) quotes.push(...sbResult);
    else if (sbResult) quotes.push(sbResult);
  } catch (e) { console.warn('[logistics] shipbubble quote:', e.message); }

  try { await _persistQuotes(sessionId, quotes); }
  catch (e) { console.warn('[logistics] persist quotes skipped:', e.message); }

  return quotes;
}

async function applyDelivery(session, method, providerId) {
  let quote = null;
  try {
    const quoteRes = await db.query(
      `SELECT * FROM delivery_quotes
       WHERE session_id = $1 AND provider = $2 AND provider_id = $3
       ORDER BY created_at DESC LIMIT 1`,
      [session.id, method, providerId]
    );
    quote = quoteRes.rows[0] || null;
  } catch (e) { console.warn('[logistics] quote lookup failed:', e.message); }

  if (!quote) quote = { fee: 0, estimated_delivery: null };

  const shippingFee = parseFloat(quote.fee);
  const subtotal = parseFloat(session.subtotal || session.total_amount || 0);
  const discount = parseFloat(session.coupon_discount || session.discount_amount || 0);
  const newTotal = subtotal - discount + shippingFee;

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

  try {
    await db.query(
      `UPDATE delivery_quotes SET is_selected = true, updated_at = NOW()
       WHERE session_id = $1 AND provider = $2 AND provider_id = $3`,
      [session.id, method, providerId]
    );
  } catch (e) { /* table may not exist yet */ }

  return updated.rows[0];
}

async function _persistQuotes(sessionId, quotes) {
  try {
    await db.query(`DELETE FROM delivery_quotes WHERE session_id = $1`, [sessionId]);
  } catch (e) {
    console.warn('[logistics] delivery_quotes table missing, skipping persist');
    return;
  }

  for (const q of quotes) {
    try {
      await db.query(
        `INSERT INTO delivery_quotes
           (session_id, provider, provider_id, provider_label, fee,
            estimated_delivery, estimated_days, notes, quote_reference,
            raw_response, is_mock, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT DO NOTHING`,
        [
          sessionId, q.provider, q.providerId, q.providerLabel, q.fee,
          q.estimatedDelivery || null, q.estimatedDays || null,
          q.notes || null, q.quoteReference || null,
          JSON.stringify(q.rawSettings || q.raw || {}),
          q.isMock ? true : false,
        ]
      );
    } catch (e) { console.warn('[logistics] insert quote failed:', e.message); }
  }
}

module.exports = { getDeliveryOptions, applyDelivery };