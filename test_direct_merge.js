require('dotenv').config();
const { mergeCart } = require('./controllers/cart.controller');

(async () => {
  // Replace with actual user id from DB
  const userId = '8cf78482-14c2-46af-8c07-97d2a5fb5d65';

  // Replace these product IDs with valid product IDs from your products table
  const sampleItems = [
    { product_id: 'e29e58fe-1cb3-4be7-bb15-e3cd37642a31', quantity: 1 }, // Smartphone X Pro
    { product_id: 'fe751b38-77a4-407b-81c5-2d73eeb6e516', quantity: 2 }  // Wireless Headphones
  ];

  // Fake req/res
  const req = { user: { id: userId }, body: { items: sampleItems } };

  const res = {
    statusCode: 200,
    data: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.data = payload; console.log('Response status:', this.statusCode); console.log(JSON.stringify(payload, null, 2)); }
  };

  try {
    await mergeCart(req, res);
    console.log('Direct merge completed');
  } catch (err) {
    console.error('Direct merge error:', err);
  }
})();
