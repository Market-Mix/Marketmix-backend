const db = require('../config/db');
const BASE = 'https://api.shipbubble.com/v1';
const KEY = process.env.SHIPBUBBLE_API_KEY;


// adapter/shipbubble.adapter.js — replace getSellerOrigin usage in getQuotes()
// Add these two sanitizer helpers at the top of the file:

function sanitizeName(name = '') {
  return name.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ').trim() || 'Seller Name';
}

function sanitizeAddress(address = '') {
  // Shipbubble needs at least a street + city — pad if too short
  const cleaned = address.trim();
  return cleaned.length >= 10 ? cleaned : `${cleaned}, Lagos, Nigeria`.trim();
}

function headers() {
  if (!KEY) throw new Error('SHIPBUBBLE_API_KEY not configured');
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
}

async function validateAddress({ name, phone, email, address }) {
  const res = await fetch(`${BASE}/shipping/address/validate`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ name, email, phone, address })
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.message || 'Address validation failed');
  return data.data.address_code;
}

async function getSellerOrigin(sellerId) {
  const r = await db.query(
    `SELECT COALESCE(s.business_address, sp.business_address) AS address,
            COALESCE(s.business_phone, sp.business_phone, u.phone) AS phone,
            COALESCE(s.business_name, sp.business_name, u.first_name||' '||u.last_name) AS name,
            COALESCE(s.business_email, sp.business_email, u.email) AS email
     FROM users u
     LEFT JOIN seller_profiles sp ON sp.user_id = u.id
     LEFT JOIN stores s ON s.user_id = u.id AND s.store_number = 1
     WHERE u.id = $1`, [sellerId]
  );
  return r.rows[0] || null;
}

// adapter/shipbubble.adapter.js — top of getQuotes()
async function getQuotes(sessionId, items, address, sellerId) {
  try {
    const sellerItems = items.filter(i => i.seller_id === sellerId);
    console.log('[shipbubble] sellerItems:', sellerItems.length, 'sellerId:', sellerId);
    if (!sellerItems.length) return [];

    const origin = await getSellerOrigin(sellerId);
    console.log('[shipbubble] origin:', origin);
    if (!origin) return [];
// adapter/shipbubble.adapter.js — inside getQuotes(), replace the two validateAddress calls

// adapter/shipbubble.adapter.js — inside getQuotes(), before the Promise.all
console.log('[shipbubble] sender address raw:', origin.address);
console.log('[shipbubble] sender address sanitized:', sanitizeAddress(origin.address));
console.log('[shipbubble] receiver address:', sanitizeAddress(`${address.address_line1 || ''}, ${address.city || ''}, ${address.state || ''}`));

const [senderCode, receiverCode] = await Promise.all([
  validateAddress({
    name:    sanitizeName(origin.name),
    phone:   origin.phone || '08000000000',
    email:   origin.email || 'seller@marketmix.com',
    address: sanitizeAddress(origin.address)
  }),
  validateAddress({
    name:    sanitizeName(address.full_name || 'Buyer'),
    phone:   address.phone || '08000000000',
    email:   address.email || 'buyer@marketmix.com',
    address: sanitizeAddress(`${address.address_line1 || ''}, ${address.city || ''}, ${address.state || ''}`)
  })
]);

    const payload = {
      sender_address_code: senderCode,
      reciever_address_code: receiverCode,
      pickup_date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
      category_id: 1,
      package_items: sellerItems.map(i => ({
        name: i.name || 'Item', description: i.name || 'Item',
        unit_weight: String(parseFloat(i.weight_kg) || 0.5),
        unit_amount: String(parseFloat(i.price)), quantity: String(i.quantity)
      })),
      package_dimension: { length: 10, width: 10, height: 10 }
    };

    const res = await fetch(`${BASE}/shipping/fetch_rates`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'Rate fetch failed');

    return (data.data.couriers || []).map(c => ({
      provider: 'shipbubble', providerId: c.courier_id, providerLabel: c.courier_name,
      sellerId, fee: c.total, isFreeShipping: false,
      estimatedDelivery: c.delivery_eta || null, estimatedDays: c.delivery_eta_time || null,
      quoteReference: `SHIPBUBBLE-${c.courier_id}-${data.data.request_token}`,
      courierId: c.courier_id, serviceCode: c.service_code, rawSettings: c,
    }));
  } catch (err) {
    console.error('[shipbubble.adapter] getQuotes error:', err.message);
    return [];
  }
}

async function bookShipment({ requestToken, courierId, serviceCode }) {
  const res = await fetch(`${BASE}/shipping/labels`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ request_token: requestToken, service_code: serviceCode || 'pickup', courier_id: courierId })
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.message || 'Shipment creation failed');

  return {
    success: true, providerShipmentId: data.data.order_id,
    trackingNumber: data.data.order_id, courierName: data.data.courier?.name || null,
    provider: 'shipbubble', isMock: false,
    estimatedDelivery: data.data.delivery_eta || null, raw: data.data,
  };
}

module.exports = { getQuotes, bookShipment };