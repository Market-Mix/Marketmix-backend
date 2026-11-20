const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../config/db');

const ids = {
  storeA: '11111111-1111-4111-8111-111111111111',
  storeB: '22222222-2222-4222-8222-222222222222',
  inactiveStore: '33333333-3333-4333-8333-333333333333',
  productA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  productB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  inactiveProduct: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  deletedProduct: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  mismatchedProduct: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
};

const requestIds = {
  first: '99999999-9999-4999-8999-999999999991',
  second: '99999999-9999-4999-8999-999999999992'
};

const stores = new Map([
  [ids.storeA, { sellerId: 'seller-a', isActive: true, isDeleted: false }],
  [ids.storeB, { sellerId: 'seller-b', isActive: true, isDeleted: false }],
  [ids.inactiveStore, { sellerId: 'seller-a', isActive: false, isDeleted: false }]
]);

const products = new Map([
  [ids.productA, { storeId: ids.storeA, sellerId: 'seller-a', isActive: true, isDeleted: false, views: 4 }],
  [ids.productB, { storeId: ids.storeA, sellerId: 'seller-a', isActive: true, isDeleted: false, views: 2 }],
  [ids.inactiveProduct, { storeId: ids.storeA, sellerId: 'seller-a', isActive: false, isDeleted: false, views: 3 }],
  [ids.deletedProduct, { storeId: ids.storeA, sellerId: 'seller-a', isActive: true, isDeleted: true, views: 5 }],
  [ids.mismatchedProduct, { storeId: ids.storeA, sellerId: 'seller-b', isActive: true, isDeleted: false, views: 1 }]
]);

let events = new Map();

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', require('../routes/products.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function mockDatabase({ failOnQuery = null } = {}) {
  products.get(ids.productA).views = 4;
  products.get(ids.productA).isActive = true;
  products.get(ids.productA).isDeleted = false;
  products.get(ids.productB).views = 2;
  products.get(ids.productB).isActive = true;
  products.get(ids.productB).isDeleted = false;
  products.get(ids.inactiveProduct).views = 3;
  products.get(ids.inactiveProduct).isActive = false;
  products.get(ids.inactiveProduct).isDeleted = false;
  products.get(ids.deletedProduct).views = 5;
  products.get(ids.deletedProduct).isActive = true;
  products.get(ids.deletedProduct).isDeleted = true;
  products.get(ids.mismatchedProduct).views = 1;
  products.get(ids.mismatchedProduct).isActive = true;
  products.get(ids.mismatchedProduct).isDeleted = false;
  events = new Map();
  let transactionTail = Promise.resolve();

  const originalTransaction = db.transaction;
  db.transaction = async (callback) => {
    let release;
    const previousTransaction = transactionTail;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previousTransaction;

    const workingProducts = new Map([...products].map(([id, product]) => [id, { ...product }]));
    const workingEvents = new Map([...events].map(([id, event]) => [id, { ...event }]));
    const client = {
      query: async (sql, params = []) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (failOnQuery && failOnQuery(normalized)) throw new Error('Mocked transaction query failure');

        if (normalized.startsWith('select p.id, p.store_id, p.seller_id, p.views')) {
          const product = workingProducts.get(params[0]);
          const store = product && stores.get(product.storeId);
          return { rows: product && store ? [{
            id: params[0],
            store_id: product.storeId,
            seller_id: product.sellerId,
            views: product.views,
            is_active: product.isActive,
            is_deleted: product.isDeleted,
            store_owner_id: store.sellerId,
            store_is_active: store.isActive,
            store_is_deleted: store.isDeleted
          }] : [] };
        }

        if (normalized.startsWith('insert into public.view_events')) {
          const [requestId, storeId, productId, sellerId] = params;
          if (workingEvents.has(requestId)) return { rows: [] };
          workingEvents.set(requestId, {
            request_id: requestId,
            view_type: 'product',
            store_id: storeId,
            product_id: productId,
            seller_id: sellerId
          });
          return { rows: [{ id: `event-${requestId}` }] };
        }

        if (normalized.startsWith('select view_type, store_id, product_id, seller_id from public.view_events')) {
          const event = workingEvents.get(params[0]);
          return { rows: event ? [event] : [] };
        }

        if (normalized.startsWith('update products')) {
          const [productId, storeId, sellerId] = params;
          const product = workingProducts.get(productId);
          const store = product && stores.get(product.storeId);
          if (!product || !product.isActive || product.isDeleted ||
              product.storeId !== storeId || product.sellerId !== sellerId ||
              !store?.isActive || store.isDeleted || store.sellerId !== sellerId) {
            return { rows: [] };
          }
          product.views += 1;
          return { rows: [{ id: productId, views: product.views }] };
        }

        throw new Error(`Unexpected transaction query: ${normalized}`);
      }
    };

    try {
      const result = await callback(client);
      products.clear();
      workingProducts.forEach((product, id) => products.set(id, product));
      events = workingEvents;
      return result;
    } finally {
      release();
    }
  };
  return () => { db.transaction = originalTransaction; };
}

async function sendView(baseUrl, productId, requestId) {
  return fetch(`${baseUrl}/${productId}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId })
  });
}

test('product view records a database-derived event and increments once', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const response = await sendView(baseUrl, ids.productA, requestIds.first);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'View tracked',
      data: { product_id: ids.productA, views: 5 }
    });
    assert.equal(products.get(ids.productA).views, 5);
    assert.deepEqual([...events.values()], [{
      request_id: requestIds.first,
      view_type: 'product',
      store_id: ids.storeA,
      product_id: ids.productA,
      seller_id: 'seller-a'
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('duplicate product request does not increment twice; request ID reused for another product conflicts', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const first = await sendView(baseUrl, ids.productA, requestIds.first);
    const duplicate = await sendView(baseUrl, ids.productA, requestIds.first);
    const mismatch = await sendView(baseUrl, ids.productB, requestIds.first);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(mismatch.status, 409);
    assert.equal(products.get(ids.productA).views, 5);
    assert.equal(products.get(ids.productB).views, 2);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('duplicate product request is rejected after the product becomes inactive', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const first = await sendView(baseUrl, ids.productA, requestIds.first);
    products.get(ids.productA).isActive = false;
    const duplicate = await sendView(baseUrl, ids.productA, requestIds.first);

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 404);
    assert.equal(products.get(ids.productA).views, 5);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('concurrent identical product requests return success and increment once', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const responses = await Promise.all([
      sendView(baseUrl, ids.productA, requestIds.second),
      sendView(baseUrl, ids.productA, requestIds.second)
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(products.get(ids.productA).views, 5);
    assert.equal(events.size, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('invalid, inactive, deleted, or mismatched products and inactive stores are rejected', async () => {
  const restore = mockDatabase();
  products.set('ffffffff-ffff-4fff-8fff-ffffffffffff', {
    storeId: ids.inactiveStore,
    sellerId: 'seller-a',
    isActive: true,
    isDeleted: false,
    views: 0
  });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    for (const productId of [
      'not-a-uuid',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ids.inactiveProduct,
      ids.deletedProduct,
      ids.mismatchedProduct
    ]) {
      const response = await sendView(baseUrl, productId, requestIds.first);
      assert.equal(response.status, 404);
    }
    assert.equal(events.size, 0);
    assert.equal(products.get(ids.inactiveProduct).views, 3);
    assert.equal(products.get(ids.deletedProduct).views, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('invalid request IDs are rejected without changing views', async () => {
  const restore = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const response = await sendView(baseUrl, ids.productA, 'invalid');
    assert.equal(response.status, 400);
    assert.equal(products.get(ids.productA).views, 4);
    assert.equal(events.size, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('event insertion failure rolls back the product counter update', async () => {
  const restore = mockDatabase({
    failOnQuery: (sql) => sql.startsWith('insert into public.view_events')
  });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const response = await sendView(baseUrl, ids.productA, requestIds.first);
    assert.equal(response.status, 500);
    assert.equal(products.get(ids.productA).views, 4);
    assert.equal(events.size, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});

test('product counter update failure rolls back the inserted event', async () => {
  const restore = mockDatabase({
    failOnQuery: (sql) => sql.startsWith('update products')
  });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;

  try {
    const response = await sendView(baseUrl, ids.productA, requestIds.first);
    assert.equal(response.status, 500);
    assert.equal(products.get(ids.productA).views, 4);
    assert.equal(events.size, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});
