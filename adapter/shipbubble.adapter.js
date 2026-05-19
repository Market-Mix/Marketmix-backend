const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
const BASE = 'https://api.shipbubble.com/v1';

async function getQuote(sessionId, items, address) {
  if (!SHIPBUBBLE_KEY || !process.env.SHIPBUBBLE_SENDER_CODE) {
    console.warn('[shipbubble.adapter] Missing SHIPBUBBLE_API_KEY or SHIPBUBBLE_SENDER_CODE');
    return [];
  }

  try {
    // Call Shipbubble rates API
    const response = await fetch(`${BASE}/shipping/fetch_rates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender_address_code: process.env.SHIPBUBBLE_SENDER_CODE,
        receiver_address: {
          name: address.full_name,
          email: address.email,
          phone: address.phone,
          address: address.address_line1,
          state: address.state,
          city: address.city
        },
        parcel: {
          items: (items || []).map(i => ({
            name: i.name,
            quantity: i.quantity,
            weight: 0.5  // default until products have weight field
          }))
        }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('[shipbubble.adapter] Rates request failed:', response.status, data.message || data.error || data);
      return [];
    }

    const rates = Array.isArray(data.data) ? data.data : [];
    if (!rates.length) {
      console.warn('[shipbubble.adapter] No rates returned:', data.message || data.error || data);
      return [];
    }

    // Return in your standard shape
    return rates.map(rate => ({
      provider: 'marketmix',
      providerId: 'shipbubble',
      providerLabel: rate.courier_name || rate.courier || 'Shipbubble',
      fee: parseFloat(rate.amount || rate.total || 0),
      estimatedDelivery: rate.delivery_date || null,
      estimatedDays: rate.transit_time || null,
      quoteReference: rate.service_code || rate.request_token || null,
      raw: rate
    }));
  } catch (err) {
    console.error('[shipbubble.adapter] getQuote error:', err.message);
    return [];
  }
}

module.exports = { getQuote };
