const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
const BASE = 'https://api.shipbubble.com/v1';

async function getQuote(sessionId, items, address) {
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
        items: items.map(i => ({
          name: i.name,
          quantity: i.quantity,
          weight: 0.5  // default until products have weight field
        }))
      }
    })
  });

  const data = await response.json();

  // Return in your standard shape
  return data.data.map(rate => ({
    provider: 'shipbubble',
    providerLabel: rate.courier_name,
    fee: parseFloat(rate.amount),
    estimatedDelivery: rate.delivery_date,
    estimatedDays: rate.transit_time,
    quoteReference: rate.service_code,
    raw: rate
  }));
}

module.exports = { getQuote };