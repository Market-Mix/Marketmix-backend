const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'featured-store-impressions-test-secret';

const db = require('../config/db');

const storeA = '11111111-1111-4111-8111-111111111111';
const storeB = '22222222-2222-4222-8222-222222222222';
const inactiveStore = '33333333-3333-4333-8333-333333333333';
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const stores = new Map([
  [storeA, { sellerId: 'seller-a', isActive: true, isDeleted: false, views: 7 }],
  [storeB, { sellerId: 'seller-b', isActive: true, isDeleted: false, views: 3 }],
  [inactiveStore, { sellerId: 'seller-a', isActive: false, isDeleted: false, views: 0 }]
]);
let impressions = new Map();

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/seller/stores', require('../routes/stores.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function token(id, role = 'seller') {
  return jwt.sign({ id, email: `${id}@example.test`, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function mockDatabase() {
  impressions = new Map();
  let transactionTail = Promise.resolve();
  const originalQuery = db.query;
  const originalTransaction = db.transaction;

  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      const id = params[0];
      return {
        rows: [{
          id,
          email: `${id}@example.test`,
          role: 'seller',
          is_suspended: false
        }]
      };
    }

    if (normalized.startsWith('select id from stores')) {
      const store = stores.get(params[0]);
      return store && store.sellerId === params[1] && store.isActive && !store.isDeleted
        ? { rows: [{ id: params[0] }] }
        : { rows: [] };
    }

    if (normalized.startsWith('select count(*)::bigint as impression_count')) {
      const count = [...impressions.values()].filter((row) =>
        row.store_id === params[0] && row.seller_id === params[1]
      ).length;
      return { rows: [{ impression_count: String(count) }] };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  db.transaction = async (callback) => {
    let release;
    const previous = transactionTail;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;

    const workingImpressions = new Map([...impressions].map(([id, row]) => [id, { ...row }]));
    const client = {
      query: async (sql, params = []) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('select id, user_id, is_active, is_deleted from stores')) {
          const store = stores.get(params[0]);
          return {
            rows: store ? [{
              id: params[0],
              user_id: store.sellerId,
              is_active: store.isActive,
              is_deleted: store.isDeleted
            }] : []
          };
        }
        if (normalized.startsWith('insert into public.featured_store_impressions')) {
          const [id, storeId, sellerId] = params;
          if (workingImpressions.has(id)) return { rows: [] };
          workingImpressions.set(id, { request_id: id, store_id: storeId, seller_id: sellerId });
          return { rows: [{ id: `impression-${id}` }] };
        }
        if (normalized.startsWith('select store_id, seller_id from public.featured_store_impressions')) {
          const impression = workingImpressions.get(params[0]);
          return { rows: impression ? [impression] : [] };
        }
        throw new Error(`Unexpected mock transaction query: ${normalized}`);
      }
    };

    try {
      const result = await callback(client);
      impressions = workingImpressions;
      return result;
    } finally {
      release();
    }
  };

  return () => {
    db.query = originalQuery;
    db.transaction = originalTransaction;
  };
}

function postImpression(baseUrl, targetStoreId, id = requestId) {
  return fetch(`${baseUrl}/public/${targetStoreId}/featured-impression`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: id })
  });
}

test('featured store impression records database-derived store and seller without changing store views', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores`;

  try {
    const first = await postImpression(baseUrl, storeA);
    const duplicate = await postImpression(baseUrl, storeA);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.duplicate, true);
    assert.deepEqual([...impressions.values()], [{
      request_id: requestId,
      store_id: storeA,
      seller_id: 'seller-a'
    }]);
    assert.equal(stores.get(storeA).views, 7);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('concurrent duplicate impressions are stored once and request ID conflicts are rejected', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores`;

  try {
    const responses = await Promise.all([
      postImpression(baseUrl, storeA),
      postImpression(baseUrl, storeA)
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(impressions.size, 1);
    assert.equal((await postImpression(baseUrl, storeB)).status, 409);
    assert.equal(impressions.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('inactive stores are not tracked and analytics are protected and scoped to the seller store', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores`;

  try {
    assert.equal((await postImpression(baseUrl, inactiveStore)).status, 404);
    assert.equal(impressions.size, 0);

    const analyticsUrl = `${baseUrl}/featured-store-impression-analytics`;
    assert.equal((await fetch(analyticsUrl, { headers: { 'X-Store-Id': storeA } })).status, 401);
    const crossSeller = await fetch(analyticsUrl, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': storeB
      }
    });
    assert.equal(crossSeller.status, 404);

    await postImpression(baseUrl, storeA);
    const analytics = await fetch(analyticsUrl, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': storeA
      }
    });
    assert.equal(analytics.status, 200);
    assert.equal((await analytics.json()).data.impressionCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});
