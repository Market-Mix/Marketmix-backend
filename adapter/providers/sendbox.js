// adapter/providers/sendbox.js  (NEW FILE)
const BASE = process.env.SENDBOX_BASE_URL || 'https://live.sendbox.co';
const KEY  = process.env.SENDBOX_API_KEY;

function headers() {
  if (!KEY) throw new Error('SENDBOX_API_KEY not configured');
  return { Authorization: KEY, 'Content-Type': 'application/json' };
}

function parseOriginAddress(addressStr = '') {
  const p = addressStr.split(',').map(s => s.trim()).filter(Boolean);
  return {
    street: p[0] || addressStr || 'N/A',
    city:  p[1] || process.env.SENDBOX_DEFAULT_CITY  || 'Lagos',
    state: p[2] || process.env.SENDBOX_DEFAULT_STATE || 'Lagos',
  };
}

async function getSellerOrigin(sellerId, storeId = null) {
  const db = require('../../config/db');
  const r = await db.query(
    `SELECT COALESCE(s.business_address, sp.business_address) AS address,
            COALESCE(s.business_phone, sp.business_phone, u.phone) AS phone,
            COALESCE(s.business_name, sp.business_name, u.first_name||' '||u.last_name) AS name,
            COALESCE(s.business_email, sp.business_email, u.email) AS email
     FROM users u
     LEFT JOIN seller_profiles sp ON sp.user_id = u.id
     LEFT JOIN stores s ON s.user_id = u.id
       AND s.id = COALESCE($2, (SELECT id FROM stores WHERE user_id = u.id ORDER BY store_number LIMIT 1))
     WHERE u.id = $1`, [sellerId, storeId]
  );
  return r.rows[0] || null;
}

const itemsPayload = items => items.map(i => ({
  name: i.name || 'Item', quantity: i.quantity,
  value: parseFloat(i.price_at_purchase ?? i.price),
  weight: parseFloat(i.weight_kg) || 0.5, item_type_code: 'other',
}));

async function getQuotes(sessionId, items, address) {
  if (!items.length) return [];
  const storeId = items[0]?.store_id || null;
  const origin = await getSellerOrigin(items[0].seller_id, storeId);
  if (!origin?.address) return [];
  const o = parseOriginAddress(origin.address);

  const payload = {
    origin: { first_name: origin.name || 'Seller', last_name: '', phone: origin.phone || '0000000000',
      email: origin.email, street: o.street, city: o.city, state: o.state, country: 'NG' },
    destination: { first_name: address.full_name || 'Buyer', last_name: '', phone: address.phone || '0000000000',
      street: address.address_line1, city: address.city, state: address.state, country: 'NG' },
    weight: items.reduce((s, i) => s + (parseFloat(i.weight_kg) || 0.5) * i.quantity, 0),
    dimension: { length: 10, width: 10, height: 10 },
    incoming_option: 'pickup', region: 'NG', service_type: 'local', package_type: 'general',
    total_value: items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0),
    currency: 'NGN', channel_code: 'api',
    pickup_date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    items: itemsPayload(items), service_code: 'standard',
  };

  const res = await fetch(`${BASE}/shipping/shipment_delivery_quote`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.status !== 'successful' || !data.rate) throw new Error(data.message || 'Sendbox quote failed');
  const rate = data.rate;

  return [{
    providerId: 'sendbox', providerLabel: 'MarketMix Delivery',
    fee: rate.fee, insuranceFee: rate.insurance_fee || 0, totalFee: rate.fee,
    estimatedDelivery: (rate.delivery_date || '').split(' ')[0] || null,
    estimatedDays: rate.sla_description, serviceType: rate.service_code,
    quoteReference: rate.rate_card_id || rate.key, isMock: false, rawResponse: rate,
  }];
}

async function bookShipment({ sellerId, address, items, callbackUrl }) {
  const storeId = items[0]?.store_id || null;
  const origin = await getSellerOrigin(sellerId, storeId);
  const o = parseOriginAddress(origin?.address || '');
  const payload = {
    origin: { first_name: origin?.name || 'Seller', last_name: '', phone: origin?.phone || '0000000000',
      email: origin?.email, street: o.street, city: o.city, state: o.state, country: 'NG' },
    destination: { first_name: address.full_name || 'Buyer', last_name: '', phone: address.phone || '0000000000',
      street: address.address_line1, city: address.city, state: address.state, country: 'NG' },
    weight: items.reduce((s, i) => s + (parseFloat(i.weight_kg) || 0.5) * i.quantity, 0),
    dimension: { length: 10, width: 10, height: 10 },
    incoming_option: 'pickup', region: 'NG', service_type: 'local', package_type: 'general',
    total_value: items.reduce((s, i) => s + parseFloat(i.price_at_purchase ?? i.price) * i.quantity, 0),
    currency: 'NGN', channel_code: 'api',
    pickup_date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    items: itemsPayload(items), service_code: 'standard',
    callback_url: callbackUrl || `${process.env.APP_BASE_URL}/api/webhooks/sendbox`,
  };

  const res = await fetch(`${BASE}/shipping/shipments`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  const data = await res.json();
  if (!data.id && !data._id) throw new Error(data.message || 'Sendbox shipment creation failed');

  return {
    success: true, providerShipmentId: data.id || data._id,
    trackingNumber: data.tracking_code || data.code, courierName: data.courier?.name || null,
    provider: 'marketmix', providerId: 'sendbox', isMock: false,
    estimatedDelivery: data.pickup_date || null, raw: data,
  };
}

module.exports = { getQuotes, bookShipment, getSellerOrigin };