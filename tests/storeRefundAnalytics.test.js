const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'store-refund-analytics-test-secret';

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

test('store refund analytics counts only consistent order-item reports for the active owned store', async () => {
  const originalQuery = db.query;
  const stores = new Map([
    ['store-a', { sellerId: 'seller-a', isActive: true, isDeleted: false }],
    ['store-inactive', { sellerId: 'seller-a', isActive: false, isDeleted: false }],
    ['store-deleted', { sellerId: 'seller-a', isActive: true, isDeleted: true }],
    ['store-other-seller', { sellerId: 'seller-b', isActive: true, isDeleted: false }]
  ]);
  const orderItems = new Map([
    ['item-product-mismatch', { orderId: 'order-shared', sellerId: 'seller-a', storeId: 'store-a' }],
    ['item-second-report', { orderId: 'order-shared', sellerId: 'seller-a', storeId: 'store-a' }],
    ['item-order-mismatch', { orderId: 'different-order', sellerId: 'seller-a', storeId: 'store-a' }],
    ['item-seller-mismatch', { orderId: 'order-seller-mismatch', sellerId: 'seller-b', storeId: 'store-a' }],
    ['item-other-store', { orderId: 'order-other-store', sellerId: 'seller-a', storeId: 'store-b' }]
  ]);
  const cases = [
    { id: 'case-product-mismatch', orderId: 'order-shared', orderItemId: 'item-product-mismatch', sellerId: 'seller-a', productId: 'old-product', status: 'pending' },
    { id: 'case-second-report', orderId: 'order-shared', orderItemId: 'item-second-report', sellerId: 'seller-a', productId: 'item-product', status: 'refund_rejected' },
    { id: 'case-order-mismatch', orderId: 'case-order', orderItemId: 'item-order-mismatch', sellerId: 'seller-a', productId: 'product-a', status: 'resolved' },
    { id: 'case-seller-mismatch', orderId: 'order-seller-mismatch', orderItemId: 'item-seller-mismatch', sellerId: 'seller-a', productId: 'product-b', status: 'processing' },
    { id: 'case-missing-item', orderId: 'order-missing-item', orderItemId: null, sellerId: 'seller-a', productId: 'product-a', status: 'pending' },
    { id: 'case-other-store', orderId: 'order-other-store', orderItemId: 'item-other-store', sellerId: 'seller-a', productId: 'product-a', status: 'pending' }
  ];

  let analyticsQuery = '';
  let analyticsParams;
  let storeQuery = '';
  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');

    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      return {
        rows: [{
          id: params[0],
          email: `${params[0]}@example.test`,
          role: 'seller',
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

    if (normalized.includes('from refund_cases rc')) {
      analyticsQuery = normalized;
      analyticsParams = params;
      assert.doesNotMatch(normalized, /refund_transactions/);

      const reportIds = new Set();
      for (const refundCase of cases) {
        const orderItem = orderItems.get(refundCase.orderItemId);
        if (!orderItem ||
            orderItem.orderId !== refundCase.orderId ||
            orderItem.sellerId !== refundCase.sellerId ||
            orderItem.storeId !== params[0] ||
            orderItem.sellerId !== params[1]) {
          continue;
        }
        reportIds.add(refundCase.id);
      }

      return { rows: [{ refund_reports_received: String(reportIds.size) }] };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/refund-analytics`;
  const headers = { Authorization: `Bearer ${token('seller-a')}` };

  try {
    const response = await fetch(`${baseUrl}?storeId=store-a`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      message: 'Store refund analytics fetched',
      data: {
        storeId: 'store-a',
        refundReportsReceived: 2
      }
    });
    assert.deepEqual(analyticsParams, ['store-a', 'seller-a']);
    assert.match(storeQuery, /user_id = \$2/);
    assert.match(storeQuery, /is_active = true/);
    assert.match(storeQuery, /is_deleted = false/);
    assert.match(analyticsQuery, /count\(distinct rc\.id\)::integer/);
    assert.match(analyticsQuery, /oi\.id = rc\.order_item_id/);
    assert.match(analyticsQuery, /oi\.order_id = rc\.order_id/);
    assert.match(analyticsQuery, /oi\.seller_id = rc\.seller_id/);
    assert.match(analyticsQuery, /oi\.store_id = \$1/);
    assert.match(analyticsQuery, /oi\.seller_id = \$2/);
    assert.doesNotMatch(analyticsQuery, /rc\.product_id\s*=/);
    assert.doesNotMatch(analyticsQuery, /status\s*=/);

    const otherStore = await fetch(`${baseUrl}?storeId=store-other-seller`, { headers });
    assert.equal(otherStore.status, 404);
    const inactiveStore = await fetch(`${baseUrl}?storeId=store-inactive`, { headers });
    assert.equal(inactiveStore.status, 404);
    const deletedStore = await fetch(`${baseUrl}?storeId=store-deleted`, { headers });
    assert.equal(deletedStore.status, 404);

    assert.equal(analyticsQuery.includes('refund_transactions'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store refund analytics rejects unauthenticated requests', async () => {
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/refund-analytics?storeId=store-a`;
  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
