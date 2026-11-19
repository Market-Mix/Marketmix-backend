const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'store-review-analytics-test-secret';

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

function makeReview({ rating, storeId = 'store-a', sellerId = 'seller-a', ...overrides }) {
  return {
    rating,
    isDeleted: false,
    isApproved: true,
    moderationStatus: 'published',
    productDeleted: false,
    storeId,
    sellerId,
    ...overrides
  };
}

const reviewFixtures = [
  makeReview({ rating: 5 }),
  makeReview({ rating: 4 }),
  makeReview({ rating: 1, isDeleted: true }),
  makeReview({ rating: 2, isApproved: false }),
  makeReview({ rating: 3, moderationStatus: 'pending' }),
  makeReview({ rating: 5, productDeleted: true }),
  makeReview({ rating: 1, storeId: 'store-b' }),
  makeReview({ rating: 1, sellerId: 'seller-b' })
];

test('store review analytics counts and averages only qualifying active-store reviews', async () => {
  const originalQuery = db.query;
  let analyticsQuery = '';
  let analyticsParams;
  let reviews = reviewFixtures;
  const stores = new Map([
    ['store-a', 'seller-a'],
    ['store-b', 'seller-a'],
    ['store-other-seller', 'seller-b']
  ]);

  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');

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

    if (normalized.includes('from stores') &&
        normalized.includes('where id = $1 and user_id = $2') &&
        normalized.includes('is_deleted = false') &&
        normalized.includes('is_active = true')) {
      return stores.get(params[0]) === params[1]
        ? { rows: [{ id: params[0] }] }
        : { rows: [] };
    }

    if (normalized.includes('from reviews r join products p on p.id = r.product_id')) {
      analyticsQuery = normalized;
      analyticsParams = params;
      const qualifyingReviews = reviews.filter((review) =>
        review.isDeleted === false &&
        review.isApproved === true &&
        review.moderationStatus === 'published' &&
        review.productDeleted === false &&
        review.storeId === params[0] &&
        review.sellerId === params[1]
      );
      const average = qualifyingReviews.length
        ? Math.round((qualifyingReviews.reduce((sum, review) => sum + review.rating, 0) /
          qualifyingReviews.length) * 100) / 100
        : 0;
      return {
        rows: [{
          total_reviews: String(qualifyingReviews.length),
          average_rating: average.toFixed(2)
        }]
      };
    }

    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores`;
  const headers = {
    Authorization: `Bearer ${token('seller-a')}`,
    'X-Store-Id': 'store-a'
  };

  try {
    const response = await fetch(`${baseUrl}/review-analytics`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, {
      storeId: 'store-a',
      totalReviews: 2,
      averageRating: 4.5
    });
    assert.deepEqual(analyticsParams, ['store-a', 'seller-a']);
    assert.match(analyticsQuery, /r\.is_deleted = false/);
    assert.match(analyticsQuery, /r\.is_approved = true/);
    assert.match(analyticsQuery, /r\.moderation_status = 'published'/);
    assert.match(analyticsQuery, /p\.is_deleted = false/);
    assert.match(analyticsQuery, /p\.store_id = \$1/);
    assert.match(analyticsQuery, /p\.seller_id = \$2/);
    assert.match(analyticsQuery, /round\(coalesce\(avg\(r\.rating\), 0\)::numeric, 2\)/);

    const anotherOwnedStore = await fetch(`${baseUrl}/review-analytics?storeId=store-b`, {
      headers: { Authorization: headers.Authorization }
    });
    assert.equal(anotherOwnedStore.status, 200);
    const anotherStoreBody = await anotherOwnedStore.json();
    assert.equal(anotherStoreBody.data.totalReviews, 1);
    assert.equal(anotherStoreBody.data.averageRating, 1);

    const otherSellerStore = await fetch(`${baseUrl}/review-analytics`, {
      headers: {
        Authorization: headers.Authorization,
        'X-Store-Id': 'store-other-seller'
      }
    });
    assert.equal(otherSellerStore.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store review analytics returns zero values when there are no qualifying reviews', async () => {
  const originalQuery = db.query;
  db.query = async (sql, params = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
    if (normalized.includes('from users where id = $1 and is_deleted = false')) {
      return { rows: [{ id: params[0], role: 'seller', is_suspended: false }] };
    }
    if (normalized.includes('from stores') && normalized.includes('where id = $1 and user_id = $2')) {
      return params[0] === 'store-a' && params[1] === 'seller-a'
        ? { rows: [{ id: 'store-a' }] }
        : { rows: [] };
    }
    if (normalized.includes('from reviews r join products p on p.id = r.product_id')) {
      return { rows: [{ total_reviews: '0', average_rating: '0.00' }] };
    }
    throw new Error(`Unexpected mock query: ${normalized}`);
  };

  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/review-analytics`;
  try {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${token('seller-a')}`,
        'X-Store-Id': 'store-a'
      }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.totalReviews, 0);
    assert.equal(body.data.averageRating, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
  }
});

test('store review analytics rejects unauthenticated requests', async () => {
  const server = await startTestApp();
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/seller/stores/review-analytics`;
  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
