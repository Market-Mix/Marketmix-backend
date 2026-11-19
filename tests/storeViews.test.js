const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'store-views-test-secret';

const db = require('../config/db');

const ids = {
  storeA: '11111111-1111-4111-8111-111111111111',
  storeB: '22222222-2222-4222-8222-222222222222',
  inactive: '33333333-3333-4333-8333-333333333333',
  deleted: '44444444-4444-4444-8444-444444444444'
};

const stores = new Map([
  [ids.storeA, { sellerId: 'seller-a', isActive: true, isDeleted: false, views: 7 }],
  [ids.storeB, { sellerId: 'seller-b', isActive: true, isDeleted: false, views: 3 }],
  [ids.inactive, { sellerId: 'seller-a', isActive: false, isDeleted: false, views: 2 }],
  [ids.deleted, { sellerId: 'seller-a', isActive: true, isDeleted: true, views: 5 }]
]);

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

function mockQueries() {
  stores.get(ids.storeA).views = 7;
  stores.get(ids.storeB).views = 3;
  stores.get(ids.inactive).views = 2;
  stores.get(ids.deleted).views = 5;
  const queries = [];
  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });

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

    if (normalized.startsWith('update stores') && normalized.includes('views = views + 1')) {
      const store = stores.get(params[0]);
      if (!store || !store.isActive || store.isDeleted) return { rows: [] };
      store.views += 1;
      return { rows: [{ id: params[0], views: store.views }] };
    }

    if (normalized.startsWith('select id, views from stores')) {
      const store = stores.get(params[0]);
      if (!store || store.sellerId !== params[1] || !store.isActive || store.isDeleted) {
        return { rows: [] };
      }
      return { rows: [{ id: params[0], views: store.views }] };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };
  return queries;
}

test('public store visit atomically increments the requested active store', async () => {
  const originalQuery = db.query;
  const queries = mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;

  try {
    const response = await fetch(url, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'Store view tracked',
      data: { storeId: ids.storeA, views: 8 }
    });
    assert.match(queries[0].sql, /set views = views \+ 1/);
    assert.match(queries[0].sql, /is_active = true/);
    assert.match(queries[0].sql, /is_deleted = false/);
    assert.deepEqual(queries[0].params, [ids.storeA]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('public tracking rejects invalid, inactive, deleted, and unknown stores', async () => {
  const originalQuery = db.query;
  const queries = mockQueries();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/public`;

  try {
    for (const storeId of ['not-a-uuid', ids.inactive, ids.deleted, '55555555-5555-4555-8555-555555555555']) {
      const response = await fetch(`${baseUrl}/${storeId}/view`, { method: 'POST' });
      assert.equal(response.status, 404);
    }
    assert.equal(queries.length, 3);
    assert.equal(stores.get(ids.inactive).views, 2);
    assert.equal(stores.get(ids.deleted).views, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('each distinct public page visit increments the count once', async () => {
  const originalQuery = db.query;
  mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;

  try {
    const first = await fetch(url, { method: 'POST' });
    const second = await fetch(url, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(stores.get(ids.storeA).views, 9);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('seller store-view analytics requires seller authentication and ownership', async () => {
  const originalQuery = db.query;
  const queries = mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/store-view-analytics`;

  try {
    const unauthenticated = await fetch(url, { headers: { 'X-Store-Id': ids.storeA } });
    assert.equal(unauthenticated.status, 401);

    const buyer = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token('buyer-a', 'buyer')}`,
        'X-Store-Id': ids.storeA
      }
    });
    assert.equal(buyer.status, 403);

    const invalidStore = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': 'not-a-uuid'
      }
    });
    assert.equal(invalidStore.status, 404);

    const crossSeller = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': ids.storeB
      }
    });
    assert.equal(crossSeller.status, 404);
    assert.equal(queries.filter(({ sql }) => sql.includes('from stores')).length, 1);
    assert.match(queries.find(({ sql }) => sql.startsWith('select id, views from stores')).sql, /user_id = \$2/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('seller store-view analytics excludes inactive and deleted stores and returns zero views', async () => {
  const originalQuery = db.query;
  mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/store-view-analytics`;
  const authorization = `Bearer ${token('seller-a')}`;

  try {
    for (const storeId of [ids.inactive, ids.deleted]) {
      const response = await fetch(url, {
        headers: { Authorization: authorization, 'X-Store-Id': storeId }
      });
      assert.equal(response.status, 404);
    }

    stores.get(ids.storeA).views = 0;
    const response = await fetch(url, {
      headers: { Authorization: authorization, 'X-Store-Id': ids.storeA }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'Store view analytics fetched',
      data: { storeId: ids.storeA, storeViews: 0 }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});
