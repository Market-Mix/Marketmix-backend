const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
const BASE = 'https://api.shipbubble.com/v1';

async function getQuote(sessionId, items, address) {
  if (!SHIPBUBBLE_KEY) {
    throw new Error('[shipbubble.adapter] Missing SHIPBUBBLE_API_KEY');
  }

  try {
    const response = await fetch(`${BASE}/shipping/fetch_rates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
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
            weight: 0.5
          }))
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.message || 'Shipbubble API error');
    }

    const rates = Array.isArray(data.data) ? data.data : [];

    return rates.map(rate => ({
      provider: 'shipbubble',
      label: rate.courier_name,
      fee: Number(rate.amount || 0),
      eta: rate.delivery_date || null,
      raw: rate
    }));

  } catch (err) {
    console.error('[shipbubble.adapter] getQuote error:', err);
    throw err;
  }
}

module.exports = { getQuote };