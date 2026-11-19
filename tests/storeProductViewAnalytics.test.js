const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'store-product-view-analytics-test-secret';

const db = require('../config/db');

async function startTestApp() {
  const app = express();
  app.use('/api/seller/stores', require('../routes/stores.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function token(id, role = 'seller') {
  return jwt.sign({ id, email: `${id}@example.test`, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function mockQueries({ stores, products }) {
  let analyticsQuery = '';
  let analyticsParams;
  let analyticsCalls = 0;
  let storeQuery = '';
  const queries = [];

  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
    queries.push(normalized);

    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      const id = params[0];
      return {
        rows: [{
          id,
          email: `${id}@example.test`,
          role: id === 'buyer-a' ? 'buyer' : 'seller',
          is_suspended: false
        }]
      };
    }

    if (normalized.includes('from stores') && normalized.includes('where id = $1 and user_id = $2')) {
      storeQuery = normalized;
      const store = stores.get(params[0]);
      return store &&
        store.sellerId === params[1] &&
        store.isActive &&
        !store.isDeleted
        ? { rows: [{ id: params[0] }] }
        : { rows: [] };
    }

    if (normalized.includes('from products p')) {
      analyticsCalls += 1;
      analyticsQuery = normalized;
      analyticsParams = params;
      const qualifyingProducts = products.filter((product) =>
        product.storeId === params[0] &&
        product.sellerId === params[1] &&
        product.isActive === true &&
        product.isDeleted === false
      );
      return {
        rows: [{
          total_product_views: String(qualifyingProducts.reduce((total, product) => total + product.views, 0)),
          products: qualifyingProducts
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
            .map((product) => ({
              productId: product.id,
              productName: product.name,
              views: product.views
            }))
        }]
      };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  return {
    get analyticsQuery() { return analyticsQuery; },
    get analyticsParams() { return analyticsParams; },
    get analyticsCalls() { return analyticsCalls; },
    get storeQuery() { return storeQuery; },
    queries
  };
}

const storeFixtures = new Map([
  ['store-a', { sellerId: 'seller-a', isActive: true, isDeleted: false }],
  ['store-inactive', { sellerId: 'seller-a', isActive: false, isDeleted: false }],
  ['store-deleted', { sellerId: 'seller-a', isActive: true, isDeleted: true }],
  ['store-other-seller', { sellerId: 'seller-b', isActive: true, isDeleted: false }]
]);

const productFixtures = [
  { id: 'product-b', name: 'Beta', storeId: 'store-a', sellerId: 'seller-a', isActive: true, isDeleted: false, views: 7 },
  { id: 'product-a', name: 'Alpha', storeId: 'store-a', sellerId: 'seller-a', isActive: true, isDeleted: false, views: 3 },
  { id: 'product-zero', name: 'Zero', storeId: 'store-a', sellerId: 'seller-a', isActive: true, isDeleted: false, views: 0 },
  { id: 'product-inactive', name: 'Inactive', storeId: 'store-a', sellerId: 'seller-a', isActive: false, isDeleted: false, views: 50 },
  { id: 'product-deleted', name: 'Deleted', storeId: 'store-a', sellerId: 'seller-a', isActive: true, isDeleted: true, views: 60 },
  { id: 'product-other-store', name: 'Other store', storeId: 'store-b', sellerId: 'seller-a', isActive: true, isDeleted: false, views: 100 },
  { id: 'product-other-seller', name: 'Other seller', storeId: 'store-a', sellerId: 'seller-b', isActive: true, isDeleted: false, views: 200 }
];

test('store product view analytics returns active-store total and individual product views', async () => {
  const originalQuery = db.query;
  const mock = mockQueries({ stores: storeFixtures, products: productFixtures });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/product-view-analytics`;

  try {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': 'store-a'
      }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'Store product view analytics fetched',
      data: {
        storeId: 'store-a',
        totalProductViews: 10,
        products: [
          { productId: 'product-a', productName: 'Alpha', views: 3 },
          { productId: 'product-b', productName: 'Beta', views: 7 },
          { productId: 'product-zero', productName: 'Zero', views: 0 }
        ]
      }
    });
    assert.deepEqual(mock.analyticsParams, ['store-a', 'seller-a']);
    assert.match(mock.storeQuery, /user_id = \$2/);
    assert.match(mock.storeQuery, /is_active = true/);
    assert.match(mock.storeQuery, /is_deleted = false/);
    assert.match(mock.analyticsQuery, /p\.store_id = \$1/);
    assert.match(mock.analyticsQuery, /p\.seller_id = \$2/);
    assert.match(mock.analyticsQuery, /p\.is_active = true/);
    assert.match(mock.analyticsQuery, /p\.is_deleted = false/);
    assert.doesNotMatch(mock.analyticsQuery, /product_listings/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store product view analytics rejects unauthenticated and non-seller requests', async () => {
  const originalQuery = db.query;
  mockQueries({ stores: storeFixtures, products: productFixtures });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/product-view-analytics`;

  try {
    const unauthenticated = await fetch(baseUrl, { headers: { 'X-Store-Id': 'store-a' } });
    assert.equal(unauthenticated.status, 401);

    const buyer = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${token('buyer-a', 'buyer')}`,
        'X-Store-Id': 'store-a'
      }
    });
    assert.equal(buyer.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store product view analytics rejects cross-seller, inactive, and deleted stores before aggregation', async () => {
  const originalQuery = db.query;
  const mock = mockQueries({ stores: storeFixtures, products: productFixtures });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/product-view-analytics`;
  const authorization = `Bearer ${token('seller-a')}`;

  try {
    for (const storeId of ['store-other-seller', 'store-inactive', 'store-deleted']) {
      const response = await fetch(baseUrl, {
        headers: { Authorization: authorization, 'X-Store-Id': storeId }
      });
      assert.equal(response.status, 404);
    }
    assert.equal(mock.analyticsCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store product view analytics returns zero and an empty product list when no active products exist', async () => {
  const originalQuery = db.query;
  mockQueries({ stores: storeFixtures, products: [] });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/product-view-analytics`;

  try {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': 'store-a'
      }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.totalProductViews, 0);
    assert.deepEqual(body.data.products, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});
