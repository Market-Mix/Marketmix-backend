

const PROVIDERS = {
  kwik:       tryLoad('./providers/kwik'),
  sendbox:    tryLoad('./providers/sendbox'),
  gig:        tryLoad('./providers/gig'),
};

function tryLoad(path) {
  try { return require(path); } catch (_) { return null; }
}

// ─── Public: getQuotes ────────────────────────────────────────
/**
 * Fetches quotes from every active provider in parallel.
 * Falls back to mock quotes if no real providers are configured.
 *
 * @param {string} sessionId
 * @param {Array}  items     - cart/vendor_order rows with seller_id, price, quantity
 * @param {Object} address   - buyer delivery address { city, state, country }
 * @returns {Promise<QuoteResult[]>}
 */
async function getQuotes(sessionId, items, address) {
  // Mocks retired now that Shipbubble is live.
  // Real providers (sendbox, gig, etc.) still aggregate here if configured.
  const activeProviders = Object.entries(PROVIDERS).filter(([, mod]) => mod !== null);
  if (activeProviders.length === 0) return [];

  const results = await Promise.allSettled(
    activeProviders.map(([name, mod]) =>
      mod.getQuotes(sessionId, items, address).then(quotes =>
        quotes.map(q => ({ ...q, provider: 'marketmix', providerId: q.providerId || name }))
      )
    )
  );
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

// ─── Public: bookShipment ─────────────────────────────────────
/**
 * Books a shipment with the selected provider.
 *
 * @param {string} providerId  - which provider to use
 * @param {object} shipmentData
 * @returns {Promise<BookingResult>}
 */
async function bookShipment(providerId, shipmentData) {
  const provider = PROVIDERS[providerId];

  if (!provider || process.env.LOGISTICS_MOCK === 'false') {
    return mockBookShipment(providerId, shipmentData);
  }

  return provider.bookShipment(shipmentData);
}

// ─── Mock quotes (always available) ──────────────────────────
function getMockQuotes(items, address) {
  const subtotal = items.reduce(
    (sum, i) => sum + parseFloat(i.price || 0) * parseInt(i.quantity || 1),
    0
  );

  const state = (address?.state || '').toLowerCase();
  const isLagos = state.includes('lagos');

  const now = new Date();

  const options = [
    {
      providerId:        'mock_standard',
      providerLabel:     'MarketMix Standard',
      fee:               isLagos ? 1500 : 2500,
      insuranceFee:      0,
      estimatedDays:     isLagos ? '1–2 business days' : '3–5 business days',
      daysOffset:        isLagos ? 2 : 5,
      serviceType:       'standard',
    },
    {
      providerId:        'mock_express',
      providerLabel:     'MarketMix Express',
      fee:               isLagos ? 2800 : 4500,
      insuranceFee:      subtotal > 50000 ? Math.round(subtotal * 0.005) : 0,
      estimatedDays:     isLagos ? 'Same day' : '1–2 business days',
      daysOffset:        isLagos ? 0 : 2,
      serviceType:       'express',
    },
  ];

  return options.map(opt => {
    const eta = new Date(now);
    eta.setDate(eta.getDate() + opt.daysOffset);

    return {
      provider:          'marketmix',
      providerId:        opt.providerId,
      providerLabel:     opt.providerLabel,
      fee:               opt.fee,
      insuranceFee:      opt.insuranceFee,
      totalFee:          opt.fee + opt.insuranceFee,
      estimatedDelivery: eta.toISOString().split('T')[0],
      estimatedDays:     opt.estimatedDays,
      serviceType:       opt.serviceType,
      quoteReference:    `MOCK-${opt.providerId.toUpperCase()}-${Date.now()}`,
      isMock:            true,
      rawResponse:       {},
    };
  });
}

function mockBookShipment(providerId, data) {
  return {
    success:        true,
    providerShipmentId: `MOCK-SHIP-${Date.now()}`,
    trackingNumber:     `MX${Math.floor(Math.random() * 1e9)}`,
    provider:           'marketmix',
    providerId,
    isMock:             true,
    estimatedDelivery:  data.estimatedDelivery || null,
  };
}

// ─── Provider scaffold (copy to add a real provider) ─────────
/*
// adapter/providers/shipbubble.js
const axios = require('axios');

const BASE = 'https://api.shipbubble.com/v1';
const KEY  = process.env.SHIPBUBBLE_API_KEY;

async function getQuotes(sessionId, items, address) {
  const res = await axios.post(`${BASE}/shipping/fetch_rates`, {
    origin:      { ... },
    destination: { state: address.state, city: address.city },
    parcel:      { ... },
  }, { headers: { Authorization: `Bearer ${KEY}` } });

  return res.data.data.map(rate => ({
    providerId:        'shipbubble',
    providerLabel:     rate.courier_name,
    fee:               parseFloat(rate.amount),
    insuranceFee:      0,
    totalFee:          parseFloat(rate.amount),
    estimatedDelivery: rate.delivery_date,
    estimatedDays:     rate.transit_time,
    serviceType:       rate.service_type,
    quoteReference:    rate.service_code,
    isMock:            false,
    rawResponse:       rate,
  }));
}

async function bookShipment(data) {
  const res = await axios.post(`${BASE}/shipments/create`, { ... },
    { headers: { Authorization: `Bearer ${KEY}` } });
  return {
    success:            true,
    providerShipmentId: res.data.id,
    trackingNumber:     res.data.tracking_number,
    providerId:         'shipbubble',
    isMock:             false,
  };
}

module.exports = { getQuotes, bookShipment };
*/

module.exports = { getQuotes, bookShipment };