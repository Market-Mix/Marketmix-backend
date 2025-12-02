// Node smoke test for cart endpoints
// Usage:
//   TEST_API_URL=http://localhost:5000/api TEST_TOKEN=<JWT> TEST_PRODUCT_ID=<PROD_ID> node frontend-utils/test_cart_ops.js

const API = process.env.TEST_API_URL || 'http://localhost:5000/api';
const TOKEN = process.env.TEST_TOKEN;
const PRODUCT_ID = process.env.TEST_PRODUCT_ID;

if (!TOKEN) {
  console.error('Please set TEST_TOKEN env var to a valid JWT for a test user');
  process.exit(1);
}
if (!PRODUCT_ID) {
  console.error('Please set TEST_PRODUCT_ID env var to a valid product id');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`
};

(async function run() {
  try {
    console.log('[1] Fetching cart...');
    let res = await fetch(`${API}/cart`, { headers });
    console.log('GET /cart status', res.status);
    let json = await res.json().catch(() => ({}));
    console.log('Cart items before:', json.data && json.data.items ? json.data.items.length : 0);

    console.log('[2] Adding item to cart...');
    res = await fetch(`${API}/cart/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ product_id: PRODUCT_ID, quantity: 1 })
    });
    console.log('POST /cart/add status', res.status);
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Add failed:', json);
      process.exit(1);
    }

    const cartItem = json.data && json.data.cartItem;
    console.log('Added cart item:', cartItem);

    console.log('[3] Updating item quantity to 2...');
    res = await fetch(`${API}/cart/${cartItem.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ quantity: 2 })
    });
    console.log('PUT /cart/:id status', res.status);
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Update failed:', json);
      process.exit(1);
    }
    console.log('Updated item:', json.data && json.data.cartItem);

    console.log('[4] Removing item...');
    res = await fetch(`${API}/cart/${cartItem.id}`, {
      method: 'DELETE',
      headers
    });
    console.log('DELETE /cart/:id status', res.status);
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Remove failed:', json);
      process.exit(1);
    }
    console.log('Remove response:', json.message || json);

    console.log('Smoke test completed successfully');
  } catch (err) {
    console.error('Smoke test error', err);
    process.exit(1);
  }
})();
