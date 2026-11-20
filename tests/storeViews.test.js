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
let events = new Map();
const requestIds = {
  first: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  second: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};

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

function mockQueries({ failOnQuery = null } = {}) {
  stores.get(ids.storeA).views = 7;
  stores.get(ids.storeA).isActive = true;
  stores.get(ids.storeA).isDeleted = false;
  stores.get(ids.storeB).views = 3;
  stores.get(ids.storeB).isActive = true;
  stores.get(ids.storeB).isDeleted = false;
  stores.get(ids.inactive).views = 2;
  stores.get(ids.inactive).isActive = false;
  stores.get(ids.inactive).isDeleted = false;
  stores.get(ids.deleted).views = 5;
  stores.get(ids.deleted).isActive = true;
  stores.get(ids.deleted).isDeleted = true;
  events = new Map();
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

    if (normalized.startsWith('select id, views from stores')) {
      const store = stores.get(params[0]);
      if (!store || store.sellerId !== params[1] || !store.isActive || store.isDeleted) {
        return { rows: [] };
      }
      return { rows: [{ id: params[0], views: store.views }] };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  let transactionTail = Promise.resolve();
  db.transaction = async (callback) => {
    let release;
    const previousTransaction = transactionTail;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previousTransaction;

    const workingStores = new Map([...stores].map(([id, store]) => [id, { ...store }]));
    const workingEvents = new Map([...events].map(([id, event]) => [id, { ...event }]));
    const client = {
      query: async (sql, params = []) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        queries.push({ sql: normalized, params });
        if (failOnQuery && failOnQuery(normalized)) throw new Error('Mocked transaction query failure');

        if (normalized.startsWith('select id, user_id, views, is_active, is_deleted from stores')) {
          const store = workingStores.get(params[0]);
          return {
            rows: store
              ? [{
                  id: params[0],
                  user_id: store.sellerId,
                  views: store.views,
                  is_active: store.isActive,
                  is_deleted: store.isDeleted
                }]
              : []
          };
        }
        if (normalized.startsWith('insert into public.view_events')) {
          const [requestId, storeId, sellerId] = params;
          if (workingEvents.has(requestId)) return { rows: [] };
          workingEvents.set(requestId, {
            request_id: requestId,
            view_type: 'store',
            store_id: storeId,
            product_id: null,
            seller_id: sellerId
          });
          return { rows: [{ id: `event-${requestId}` }] };
        }
        if (normalized.startsWith('select view_type, store_id, product_id, seller_id from public.view_events')) {
          const event = workingEvents.get(params[0]);
          return { rows: event ? [event] : [] };
        }
        if (normalized.startsWith('update stores')) {
          const store = workingStores.get(params[0]);
          if (!store || !store.isActive || store.isDeleted) return { rows: [] };
          store.views += 1;
          return { rows: [{ id: params[0], views: store.views }] };
        }
        throw new Error(`Unexpected transaction query: ${normalized}`);
      }
    };

    try {
      const result = await callback(client);
      stores.clear();
      workingStores.forEach((store, id) => stores.set(id, store));
      events = workingEvents;
      return result;
    } finally {
      release();
    }
  };
  return queries;
}

test('public store visit atomically increments the requested active store', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  const queries = mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestIds.first })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'Store view tracked',
      data: { storeId: ids.storeA, views: 8 }
    });
    assert.match(queries[0].sql, /for update/);
    assert.match(queries[1].sql, /from public\.view_events where request_id = \$1/);
    assert.match(queries[2].sql, /insert into public\.view_events/);
    assert.match(queries[2].sql, /on conflict \(request_id\) do nothing/);
    assert.match(queries[3].sql, /set views = coalesce\(views, 0\) \+ 1/);
    assert.equal(queries[2].params[0], requestIds.first);
    assert.deepEqual(queries[2].params.slice(1), [ids.storeA, 'seller-a']);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('public tracking rejects invalid, inactive, deleted, and unknown stores', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  const queries = mockQueries();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/public`;

  try {
    for (const storeId of ['not-a-uuid', ids.inactive, ids.deleted, '55555555-5555-4555-8555-555555555555']) {
      const response = await fetch(`${baseUrl}/${storeId}/view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestIds.first })
      });
      assert.equal(response.status, 404);
    }
    assert.equal(queries.length, 3);
    assert.equal(stores.get(ids.inactive).views, 2);
    assert.equal(stores.get(ids.deleted).views, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('duplicate store request IDs do not increment twice and mismatched identity returns conflict', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  mockQueries();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/public`;
  const send = (storeId) => fetch(`${baseUrl}/${storeId}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestIds.first })
  });

  try {
    const first = await send(ids.storeA);
    const duplicate = await send(ids.storeA);
    const mismatched = await send(ids.storeB);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(mismatched.status, 409);
    assert.equal(stores.get(ids.storeA).views, 8);
    assert.equal(stores.get(ids.storeB).views, 3);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('duplicate store request is rejected after the store becomes inactive', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestIds.first })
  };

  try {
    const first = await fetch(url, options);
    stores.get(ids.storeA).isActive = false;
    const duplicate = await fetch(url, options);

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 404);
    assert.equal(stores.get(ids.storeA).views, 8);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('concurrent identical store requests return success and increment once', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  mockQueries();
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestIds.second })
  };

  try {
    const responses = await Promise.all([fetch(url, options), fetch(url, options)]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(stores.get(ids.storeA).views, 8);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('store event insertion failure rolls back the counter update', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  const queries = mockQueries({ failOnQuery: (sql) => sql.startsWith('insert into public.view_events') });
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestIds.second })
    });
    assert.equal(response.status, 500);
    assert.equal(stores.get(ids.storeA).views, 7);
    assert.equal(events.size, 0);
    assert.equal(queries.some(({ sql }) => sql.startsWith('update stores')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('store counter update failure rolls back the inserted event', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  mockQueries({ failOnQuery: (sql) => sql.startsWith('update stores') });
  const server = await startTestApp();
  const url = `http://127.0.0.1:${server.address().port}/api/seller/stores/public/${ids.storeA}/view`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestIds.second })
    });
    assert.equal(response.status, 500);
    assert.equal(stores.get(ids.storeA).views, 7);
    assert.equal(events.size, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  }
});

test('seller store-view analytics requires seller authentication and ownership', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
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
    db.transaction = originalTransaction;
  }
});

test('seller store-view analytics excludes inactive and deleted stores and returns zero views', async () => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
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
    db.transaction = originalTransaction;
  }
});
