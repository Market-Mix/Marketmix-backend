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
  let fixtureRows = [
    { month: '2025-09', monthly_order_count: '1', gross_monthly_sales: '110' },
    { month: '2025-11', monthly_order_count: '2', gross_monthly_sales: '220' },
    { month: '2026-02', monthly_order_count: '3', gross_monthly_sales: '1210' }
  ];

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
      return { rows: fixtureRows };
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
    assert.deepEqual(ownBody.data.monthlyHistory, [
      { month: '2025-09', monthlyOrderCount: 1, grossMonthlySales: 110, netMonthlySales: 100 },
      { month: '2025-10', monthlyOrderCount: 0, grossMonthlySales: 0, netMonthlySales: 0 },
      { month: '2025-11', monthlyOrderCount: 2, grossMonthlySales: 220, netMonthlySales: 200 },
      { month: '2025-12', monthlyOrderCount: 0, grossMonthlySales: 0, netMonthlySales: 0 },
      { month: '2026-01', monthlyOrderCount: 0, grossMonthlySales: 0, netMonthlySales: 0 },
      { month: '2026-02', monthlyOrderCount: 3, grossMonthlySales: 1210, netMonthlySales: 1100 }
    ]);
    const finalHistoryMonth = ownBody.data.monthlyHistory[ownBody.data.monthlyHistory.length - 1];
    assert.equal(ownBody.data.monthlyOrderCount, finalHistoryMonth.monthlyOrderCount);
    assert.equal(ownBody.data.grossMonthlySales, finalHistoryMonth.grossMonthlySales);
    assert.equal(ownBody.data.netMonthlySales, finalHistoryMonth.netMonthlySales);

    assert.deepEqual(analyticsParams.slice(0, 2), ['seller-a', 'store-a']);
    assert.equal(analyticsParams[2], '2025-09-01 00:00:00');
    assert.equal(analyticsParams[3], '2026-03-01 00:00:00');
    assert.match(analyticsQuery, /o\.payment_status = 'paid'/);
    assert.match(analyticsQuery, /o\.paid_at >= \$3::timestamp/);
    assert.match(analyticsQuery, /o\.paid_at < \$4::timestamp/);
    assert.match(analyticsQuery, /exists \(/);
    assert.match(analyticsQuery, /pt\.status = 'success'/);
    assert.match(analyticsQuery, /count\(distinct o\.id\)/);
    assert.match(analyticsQuery, /sum\(oi\.quantity \* oi\.price_at_purchase\)/);
    assert.match(analyticsQuery, /oi\.seller_id = \$1/);
    assert.match(analyticsQuery, /oi\.store_id = \$2/);
    assert.match(analyticsQuery, /group by date_trunc\('month', o\.paid_at\)/);

    fixtureRows = [];
    const emptyMonth = await fetch(`${baseUrl}/monthly-analytics?month=2026-12`, {
      headers: { Authorization: `Bearer ${token('seller-a', 'seller')}`, 'X-Store-Id': 'store-a' }
    });
    assert.equal(emptyMonth.status, 200);
    const emptyBody = await emptyMonth.json();
    assert.equal(emptyBody.data.monthlyOrderCount, 0);
    assert.equal(emptyBody.data.grossMonthlySales, 0);
    assert.equal(emptyBody.data.netMonthlySales, 0);
    assert.deepEqual(emptyBody.data.monthlyHistory.map((item) => item.month), [
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'
    ]);
    assert.ok(emptyBody.data.monthlyHistory.every((item) =>
      item.monthlyOrderCount === 0 && item.grossMonthlySales === 0 && item.netMonthlySales === 0
    ));
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

test('monthly aggregate excludes unpaid orders and orders without a successful payment', async () => {
  const originalQuery = db.query;
  const fixtureOrders = [
    {
      id: 'paid-success',
      paymentStatus: 'paid',
      paymentStatuses: ['success'],
      items: [{ quantity: 2, priceAtPurchase: 100 }, { quantity: 1, priceAtPurchase: 50 }]
    },
    {
      id: 'unpaid-success',
      paymentStatus: 'pending',
      paymentStatuses: ['success'],
      items: [{ quantity: 1, priceAtPurchase: 900 }]
    },
    {
      id: 'paid-failed',
      paymentStatus: 'paid',
      paymentStatuses: ['failed'],
      items: [{ quantity: 1, priceAtPurchase: 700 }]
    },
    {
      id: 'paid-no-transaction',
      paymentStatus: 'paid',
      paymentStatuses: [],
      items: [{ quantity: 1, priceAtPurchase: 600 }]
    }
  ];
  let analyticsQuery = '';

  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');

    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      const id = params[0];
      return { rows: [{ id, email: `${id}@example.test`, role: 'seller', is_suspended: false }] };
    }

    if (normalized.includes('from stores') && normalized.includes('where id = $1 and user_id = $2') && normalized.includes('is_active = true')) {
      return params[0] === 'store-a' && params[1] === 'seller-a' ? { rows: [{ id: 'store-a' }] } : { rows: [] };
    }

    if (normalized.includes('count(distinct o.id) as monthly_order_count')) {
      analyticsQuery = normalized;
      assert.match(analyticsQuery, /o\.payment_status = 'paid'/);
      assert.match(analyticsQuery, /exists \([\s\S]*pt\.status = 'success'/);

      const qualifyingOrders = fixtureOrders.filter((order) =>
        order.paymentStatus === 'paid' && order.paymentStatuses.includes('success')
      );
      const grossMonthlySales = qualifyingOrders.reduce((total, order) =>
        total + order.items.reduce((orderTotal, item) =>
          orderTotal + item.quantity * item.priceAtPurchase, 0
        ), 0
      );

      return {
        rows: [{
          month: '2026-02',
          monthly_order_count: String(new Set(qualifyingOrders.map((order) => order.id)).size),
          gross_monthly_sales: String(grossMonthlySales)
        }]
      };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores`;

  try {
    const response = await fetch(`${baseUrl}/monthly-analytics?month=2026-02`, {
      headers: {
        Authorization: `Bearer ${token('seller-a', 'seller')}`,
        'X-Store-Id': 'store-a'
      }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.monthlyOrderCount, 1);
    assert.equal(body.data.grossMonthlySales, 250);
    assert.equal(body.data.netMonthlySales, 227.27);
    assert.equal(analyticsQuery.includes("o.payment_status = 'paid'"), true);
    assert.match(analyticsQuery, /pt\.status = 'success'/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});
