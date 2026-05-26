const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
const BASE = 'https://api.shipbubble.com/v1';

// Replace the entire exports
async function getQuotes(sessionId, items, address) {
  if (!SHIPBUBBLE_KEY) return []; // graceful fallback instead of throw
  
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
          email: address.email || '',
          phone: address.phone || '',
          address: address.address_line1,
          state: address.state,
          city: address.city
        },
        parcel: {
          items: items.map(i => ({
            name: i.name || 'Item',
            quantity: i.quantity,
            weight: 0.5
          }))
        }
      })
    });

    const data = await response.json();
    if (!response.ok) return [];

    return (data.data || []).map(rate => ({
      provider: 'shipbubble',
      providerId: rate.courier_code || rate.service_code || 'shipbubble',
      providerLabel: rate.courier_name,
      fee: Number(rate.amount || 0),
      insuranceFee: 0,
      totalFee: Number(rate.amount || 0),
      estimatedDelivery: rate.delivery_date || null,
      estimatedDays: rate.transit_time || '2-5 business days',
      serviceType: rate.service_type || 'standard',
      quoteReference: rate.service_code || `SB-${Date.now()}`,
      isMock: false,
      rawResponse: rate
    }));
  } catch (err) {
    console.error('[shipbubble] getQuotes error:', err.message);
    return [];
  }
}

module.exports = { getQuotes }; // was getQuote, now getQuotes