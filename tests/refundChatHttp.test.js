const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'refund-chat-http-test-secret';

const db = require('../config/db');

const caseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const buyerId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const legacySellerId = '33333333-3333-4333-8333-333333333333';
const otherSellerId = '66666666-6666-4666-8666-666666666666';
const adminId = '44444444-4444-4444-8444-444444444444';
const unauthorizedId = '55555555-5555-4555-8555-555555555555';
const refundOrderItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const anotherOrderItemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function token(id, role) {
  return jwt.sign({ id, email: `${id}@example.test`, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/refund-chat', require('../routes/refund_chat.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function mockDatabase(initial = {}) {
  const state = {
    buyerPaused: initial.buyerPaused || false,
    sellerPaused: initial.sellerPaused || false,
    resolutionStatus: initial.resolutionStatus || 'pending',
    refundSellerId: initial.refundSellerId !== undefined ? initial.refundSellerId : sellerId,
    refundOrderItemId: initial.refundOrderItemId !== undefined ? initial.refundOrderItemId : refundOrderItemId,
    orderId: '77777777-7777-4777-8777-777777777777',
    orderItemSellers: new Map([
      [refundOrderItemId, { orderId: '77777777-7777-4777-8777-777777777777', sellerId: initial.orderItemSellerId || sellerId }],
      [anotherOrderItemId, { orderId: '77777777-7777-4777-8777-777777777777', sellerId: otherSellerId }]
    ]),
    dbRoles: {
      [buyerId]: 'buyer',
      [sellerId]: 'seller',
      [legacySellerId]: 'seller',
      [otherSellerId]: 'seller',
      [adminId]: 'admin',
      [unauthorizedId]: 'buyer'
    },
    messages: [],
    notifications: []
  };
  const originalQuery = db.query;

  db.query = async (sql, params = []) => {
    const q = sql.toLowerCase().replace(/\s+/g, ' ').trim();

    if (q.includes('from users where id = $1 and is_deleted = false')) {
      const id = params[0];
      const role = state.dbRoles[id];
      return role ? { rows: [{ id, email: `${id}@example.test`, role, is_suspended: false }] } : { rows: [] };
    }

    if (q.includes('select u.role, m.status from users u left join admin_members m')) {
      const id = params[0];
      return state.dbRoles[id] === 'admin'
        ? { rows: [{ role: 'admin', status: 'active' }] }
        : { rows: [{ role: state.dbRoles[id] || null, status: null }] };
    }

    if (q.includes('select u.role as db_role, m.user_id is not null')) {
      const id = params[0];
      return state.dbRoles[id] === 'admin'
        ? { rows: [{ db_role: 'admin', has_member: false, status: 'active', custom_permissions: null, permissions: null, is_super: true, role_status: 'Active' }] }
        : { rows: [{ db_role: state.dbRoles[id] || null, has_member: false, status: null, custom_permissions: null, permissions: null, is_super: false, role_status: null }] };
    }

    if (q.includes('left join order_items oi') && q.includes('select rc.id from refund_cases rc')) {
      assert.match(q, /on rc\.order_item_id is not null and oi\.id = rc\.order_item_id/);
      assert.match(q, /rc\.seller_id is null and rc\.order_item_id is not null and oi\.seller_id = \$2/);
      assert.doesNotMatch(q, /oi\.order_id/);
      const id = params[1];
      const linkedItemSeller = state.refundOrderItemId === null
        ? null
        : state.orderItemSellers.get(state.refundOrderItemId)?.sellerId;
      const sellerMatches = id === state.refundSellerId ||
        (state.refundSellerId === null && linkedItemSeller === id);
      const authorized = id === buyerId || sellerMatches;
      return { rows: authorized ? [{ id: params[0] }] : [] };
    }

    if (q.startsWith('select rc.buyer_id') && q.includes('coalesce(rc.seller_id, oi.seller_id)')) {
      assert.match(q, /on rc\.order_item_id is not null and oi\.id = rc\.order_item_id/);
      assert.doesNotMatch(q, /oi\.order_id/);
      return {
        rows: [{
          buyer_id: buyerId,
          seller_id: state.refundSellerId ?? (state.refundOrderItemId === null
            ? null
            : state.orderItemSellers.get(state.refundOrderItemId)?.sellerId),
          resolution_status: state.resolutionStatus,
          buyer_chat_paused: state.buyerPaused,
          seller_chat_paused: state.sellerPaused
        }]
      };
    }

    if (q.startsWith('select rc.id, rc.buyer_id') && q.includes('coalesce(rc.seller_id, oi.seller_id)')) {
      assert.match(q, /on rc\.order_item_id is not null and oi\.id = rc\.order_item_id/);
      assert.doesNotMatch(q, /oi\.order_id/);
      return {
        rows: [{
          id: params[0],
          buyer_id: buyerId,
          seller_id: state.refundSellerId ?? (state.refundOrderItemId === null
            ? null
            : state.orderItemSellers.get(state.refundOrderItemId)?.sellerId),
          buyer_chat_paused: state.buyerPaused,
          seller_chat_paused: state.sellerPaused
        }]
      };
    }

    if (q.includes('select id, resolution_status, seller_marked_resolved')) {
      return { rows: [{
        id: params[0],
        resolution_status: state.resolutionStatus,
        seller_marked_resolved: false,
        buyer_confirmed_resolution: false,
        escalated_to_marketmix: false,
        buyer_chat_paused: state.buyerPaused,
        seller_chat_paused: state.sellerPaused
      }] };
    }

    if (q.startsWith('update refund_cases')) {
      const paused = params[0];
      const party = q.includes('set buyer_chat_paused') ? 'buyer' : 'seller';
      if (party === 'buyer') state.buyerPaused = paused;
      else state.sellerPaused = paused;
      return { rows: [{
        id: params[1],
        buyer_chat_paused: state.buyerPaused,
        seller_chat_paused: state.sellerPaused
      }] };
    }

    if (q.startsWith('select id, sender_id, sender_type')) {
      return { rows: [...state.messages] };
    }

    if (q.startsWith('insert into refund_messages')) {
      const message = {
        id: `message-${state.messages.length + 1}`,
        refund_case_id: params[0],
        sender_id: params[1],
        sender_type: params[2],
        message_text: params[3],
        media_url: params[4],
        media_type: params[5],
        is_read: false,
        created_at: new Date().toISOString()
      };
      state.messages.push(message);
      return { rows: [message] };
    }

    if (q.startsWith('insert into notifications')) {
      state.notifications.push({ user_id: params[0], title: params[1], message: params[2], link: params[3] });
      return { rows: [] };
    }

    if (q.startsWith('update refund_messages') && q.includes('is_read = true')) {
      return { rows: [] };
    }

    throw new Error(`Unexpected mock query: ${q}`);
  };

  return { state, restore: () => { db.query = originalQuery; } };
}

async function request(baseUrl, path, { method = 'GET', roleToken, body } = {}) {
  const headers = {};
  if (roleToken) headers.Authorization = `Bearer ${roleToken}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

test('all refund chat seller fallbacks require the exact non-null refund order item', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'refund_chat.routes.js'), 'utf8');
  const exactItemJoins = routeSource.match(/rc\.order_item_id is not null and oi\.id = rc\.order_item_id/gi) || [];

  assert.equal(exactItemJoins.length, 3);
  assert.doesNotMatch(routeSource, /oi\.order_id/);
  assert.match(routeSource, /rc\.seller_id IS NULL AND rc\.order_item_id IS NOT NULL AND oi\.seller_id = \$2/i);
  assert.match(routeSource, /COALESCE\(rc\.seller_id, oi\.seller_id\) AS seller_id/);
});

async function assertSellerChatAccess(baseUrl, id, expectedGetStatus, expectedPostStatus) {
  const sellerToken = token(id, 'seller');
  const getResponse = await request(baseUrl, `/${caseId}`, { roleToken: sellerToken });
  assert.equal(getResponse.status, expectedGetStatus, `GET access for seller ${id}`);

  const postResponse = await request(baseUrl, `/${caseId}`, {
    method: 'POST',
    roleToken: sellerToken,
    body: { message_text: 'test message' }
  });
  assert.equal(postResponse.status, expectedPostStatus, `POST access for seller ${id}`);
}

test('legacy seller is authorized only for its specifically linked order item', async () => {
  const mock = mockDatabase({ refundSellerId: null, orderItemSellerId: legacySellerId });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await assertSellerChatAccess(baseUrl, legacySellerId, 200, 201);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('refund_cases.seller_id remains primary when the linked order item names another seller', async () => {
  const mock = mockDatabase({ refundSellerId: sellerId, orderItemSellerId: legacySellerId });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await assertSellerChatAccess(baseUrl, sellerId, 200, 201);
    await assertSellerChatAccess(baseUrl, legacySellerId, 403, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('a different seller in the same multi-seller order is denied GET and POST', async () => {
  const mock = mockDatabase({ refundSellerId: null, orderItemSellerId: legacySellerId });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    assert.equal(mock.state.orderItemSellers.get(refundOrderItemId).orderId, mock.state.orderId);
    assert.equal(mock.state.orderItemSellers.get(anotherOrderItemId).orderId, mock.state.orderId);
    assert.notEqual(mock.state.orderItemSellers.get(refundOrderItemId).sellerId, otherSellerId);
    assert.equal(mock.state.orderItemSellers.get(anotherOrderItemId).sellerId, otherSellerId);
    await assertSellerChatAccess(baseUrl, otherSellerId, 403, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('NULL refund order_item_id does not authorize an order-wide legacy seller', async () => {
  const mock = mockDatabase({
    refundSellerId: null,
    refundOrderItemId: null,
    orderItemSellerId: legacySellerId
  });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await assertSellerChatAccess(baseUrl, legacySellerId, 403, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('seller mismatch with the specifically linked order item is denied GET and POST', async () => {
  const mock = mockDatabase({ refundSellerId: null, orderItemSellerId: sellerId });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await assertSellerChatAccess(baseUrl, legacySellerId, 403, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('pause and resume use admin RBAC and notify the affected party', async () => {
  const mock = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    const admin = token(adminId, 'admin');
    const pause = await request(baseUrl, `/${caseId}/pause/buyer`, { method: 'PUT', roleToken: admin });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.data.buyer_chat_paused, true);

    assert.deepEqual(mock.state.notifications.at(-1), {
      user_id: buyerId,
      title: 'Refund Chat Paused',
      message: `MarketMix has paused buyer messaging in refund case ${caseId}.`,
      link: `/buyers/buyers%20return%20report.html?case=${caseId}`
    });

    const resume = await request(baseUrl, `/${caseId}/resume/buyer`, { method: 'PUT', roleToken: admin });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.data.buyer_chat_paused, false);
    assert.equal(mock.state.notifications.at(-1).title, 'Refund Chat Resumed');

    const unauthorized = await request(baseUrl, `/${caseId}/pause/seller`, {
      method: 'PUT',
      roleToken: token(unauthorizedId, 'admin')
    });
    assert.equal(unauthorized.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('paused parties are blocked independently while the other party and admin can send', async () => {
  const mock = mockDatabase({ buyerPaused: true });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    const buyerBlocked = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(buyerId, 'buyer'), body: { message_text: 'blocked buyer message' }
    });
    assert.equal(buyerBlocked.status, 403);

    const sellerSent = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(sellerId, 'seller'), body: { message_text: 'seller message' }
    });
    assert.equal(sellerSent.status, 201);

    const adminSent = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(adminId, 'admin'), body: { message_text: 'admin message', media_url: 'https://example.test/evidence.jpg', media_type: 'image' }
    });
    assert.equal(adminSent.status, 201);
    assert.equal(mock.state.messages.at(-1).media_url, 'https://example.test/evidence.jpg');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('seller pause, buyer messaging, resume behavior, and resolution restrictions work', async () => {
  const mock = mockDatabase({ sellerPaused: true });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    const sellerBlocked = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(sellerId, 'seller'), body: { message_text: 'blocked seller message' }
    });
    assert.equal(sellerBlocked.status, 403);

    const buyerSent = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(buyerId, 'buyer'), body: { message_text: 'buyer message' }
    });
    assert.equal(buyerSent.status, 201);

    const admin = token(adminId, 'admin');
    const resume = await request(baseUrl, `/${caseId}/resume/seller`, { method: 'PUT', roleToken: admin });
    assert.equal(resume.status, 200);
    assert.equal(mock.state.sellerPaused, false);
    const sellerResumed = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(sellerId, 'seller'), body: { message_text: 'resumed seller message' }
    });
    assert.equal(sellerResumed.status, 201);

    mock.state.resolutionStatus = 'resolved';
    const resolvedBuyer = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(buyerId, 'buyer'), body: { message_text: 'resolved message' }
    });
    assert.equal(resolvedBuyer.status, 403);

    const resolvedAdmin = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: admin, body: { message_text: 'resolved admin message' }
    });
    assert.equal(resolvedAdmin.status, 201);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('message notifications use the recipient-specific buyer or seller chat link', async () => {
  const mock = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(buyerId, 'buyer'), body: { message_text: 'from buyer' }
    });
    assert.equal(mock.state.notifications.at(-1).link, `/sellers/sellers%20returns.html?case=${caseId}`);

    await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(sellerId, 'seller'), body: { message_text: 'from seller' }
    });
    assert.equal(mock.state.notifications.at(-1).link, `/buyers/buyers%20return%20report.html?case=${caseId}`);

    await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: token(adminId, 'admin'), body: { message_text: 'from admin' }
    });
    assert.equal(mock.state.notifications.at(-2).link, `/buyers/buyers%20return%20report.html?case=${caseId}`);
    assert.equal(mock.state.notifications.at(-1).link, `/sellers/sellers%20returns.html?case=${caseId}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('direct seller access remains valid and unrelated sellers and unauthenticated users are denied', async () => {
  const mock = mockDatabase({ refundSellerId: sellerId });
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    await assertSellerChatAccess(baseUrl, sellerId, 200, 201);
    await assertSellerChatAccess(baseUrl, otherSellerId, 403, 403);

    const unauthenticated = await request(baseUrl, `/${caseId}/pause/buyer`, { method: 'PUT' });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

test('stale JWT admin role cannot bypass database role or admin RBAC', async () => {
  const mock = mockDatabase();
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/refund-chat`;
  try {
    const staleAdminToken = token(unauthorizedId, 'admin');
    const post = await request(baseUrl, `/${caseId}`, {
      method: 'POST', roleToken: staleAdminToken, body: { message_text: 'not admin' }
    });
    assert.equal(post.status, 403);

    const pause = await request(baseUrl, `/${caseId}/pause/buyer`, {
      method: 'PUT', roleToken: staleAdminToken
    });
    assert.equal(pause.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});
