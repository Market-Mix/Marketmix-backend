const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'store-monthly-analytics-test-secret';

const db = require('../config/db');

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/seller/stores', require('../routes/stores.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function token(id, role) {
  return jwt.sign({ id, email: `${id}@example.test`, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

async function requestJson(baseUrl, path, authToken) {
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('monthly analytics route validates auth, role, store ownership, month and store scope', async () => {
  const originalQuery = db.query;
  let analyticsQuery = null;
  let analyticsParams = null;
  let fixtureGross = 121000 / 100;
  let fixtureOrders = 3;

  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');

    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      const id = params[0];
      return { rows: [{ id, email: `${id}@example.test`, role: id === 'buyer-a' ? 'buyer' : 'seller', is_suspended: false }] };
    }

    if (normalized.includes('from stores') && normalized.includes('where id = $1 and user_id = $2') && normalized.includes('is_active = true')) {
      if (params[0] === 'store-a' && params[1] === 'seller-a') return { rows: [{ id: 'store-a' }] };
      return { rows: [] };
    }

    if (normalized.includes('count(distinct o.id) as monthly_order_count')) {
      analyticsQuery = normalized;
      analyticsParams = params;
      return { rows: [{ monthly_order_count: String(fixtureOrders), gross_monthly_sales: String(fixtureGross) }] };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  const server = await startTestApp();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api/seller/stores`;

  try {
    const unauthenticated = await requestJson(baseUrl, '/monthly-analytics?month=2026-02', null);
    assert.equal(unauthenticated.status, 401);

    const buyer = await requestJson(baseUrl, '/monthly-analytics?month=2026-02', token('buyer-a', 'buyer'));
    assert.equal(buyer.status, 403);

    const missingStore = await requestJson(baseUrl, '/monthly-analytics?month=2026-02', token('seller-a', 'seller'));
    assert.equal(missingStore.status, 400);

    const invalidMonth = await fetch(`${baseUrl}/monthly-analytics?month=2026-13`, {
      headers: { Authorization: `Bearer ${token('seller-a', 'seller')}`, 'X-Store-Id': 'store-a' }
    });
    assert.equal(invalidMonth.status, 400);

    const otherStore = await fetch(`${baseUrl}/monthly-analytics?month=2026-02`, {
      headers: { Authorization: `Bearer ${token('seller-a', 'seller')}`, 'X-Store-Id': 'store-b' }
    });
    assert.equal(otherStore.status, 404);

    const ownStore = await fetch(`${baseUrl}/monthly-analytics?month=2026-02`, {
      headers: { Authorization: `Bearer ${token('seller-a', 'seller')}`, 'X-Store-Id': 'store-a' }
    });
    assert.equal(ownStore.status, 200);
    const ownBody = await ownStore.json();
    assert.equal(ownBody.status, 'success');
    assert.equal(ownBody.data.storeId, 'store-a');
    assert.equal(ownBody.data.month, '2026-02');
    assert.equal(ownBody.data.currency, 'NGN');
    assert.equal(ownBody.data.monthlyOrderCount, 3);
    assert.equal(ownBody.data.grossMonthlySales, 1210);
    assert.equal(ownBody.data.netMonthlySales, 1100);

    assert.deepEqual(analyticsParams.slice(0, 2), ['seller-a', 'store-a']);
    assert.equal(analyticsParams[2], '2026-02-01 00:00:00');
    assert.equal(analyticsParams[3], '2026-03-01 00:00:00');
    assert.match(analyticsQuery, /o\.payment_status = 'paid'/);
    assert.match(analyticsQuery, /o\.paid_at >= \$3::timestamp/);
    assert.match(analyticsQuery, /o\.paid_at < \$4::timestamp/);
    assert.match(analyticsQuery, /exists \(/);
    assert.match(analyticsQuery, /pt\.status = 'success'/);
    assert.match(analyticsQuery, /count\(distinct o\.id\)/);
    assert.match(analyticsQuery, /sum\(oi\.quantity \* oi\.price_at_purchase\)/);

    fixtureOrders = 0;
    fixtureGross = 0;
    const emptyMonth = await fetch(`${baseUrl}/monthly-analytics?month=2026-12`, {
      headers: { Authorization: `Bearer ${token('seller-a', 'seller')}`, 'X-Store-Id': 'store-a' }
    });
    assert.equal(emptyMonth.status, 200);
    const emptyBody = await emptyMonth.json();
    assert.equal(emptyBody.data.monthlyOrderCount, 0);
    assert.equal(emptyBody.data.grossMonthlySales, 0);
    assert.equal(emptyBody.data.netMonthlySales, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('monthly analytics implementation contains the required payment and scope predicates', () => {
  const source = fs.readFileSync(require.resolve('../controllers/stores.controller'), 'utf8');
  assert.match(source, /o\.payment_status = 'paid'/);
  assert.match(source, /pt\.status = 'success'/);
  assert.match(source, /COUNT\(DISTINCT o\.id\)/i);
  assert.match(source, /oi\.seller_id = \$1/);
  assert.match(source, /oi\.store_id = \$2/);
  assert.match(source, /o\.paid_at >= \$3::timestamp/);
  assert.match(source, /o\.paid_at < \$4::timestamp/);
  assert.match(source, /stripFee\(grossMonthlySales\)/);
});
