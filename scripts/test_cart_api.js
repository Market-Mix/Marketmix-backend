require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    // Get first user
    const userRes = await db.query('SELECT id, email FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      console.error('No users found');
      process.exit(1);
    }
    
    const userId = userRes.rows[0].id;
    const email = userRes.rows[0].email;
    console.log('Test User:', email, userId);

    // Get JWT token
    const jwtUtils = require('../utils/jwt');
    const token = jwtUtils.generateToken({
      id: userId,
      email: email,
      role: 'buyer'
    });

    console.log('\nGenerated Token:', token.substring(0, 20) + '...');

    // Get product ID
    const productRes = await db.query('SELECT id, name FROM products LIMIT 1');
    const productId = productRes.rows[0].id;
    console.log('Test Product:', productRes.rows[0].name, productId);

    // Test POST /api/cart/add
    console.log('\n🧪 Testing POST /api/cart/add...');
    const response = await fetch(
      'https://marketmix-backend-production.up.railway.app/api/cart/add',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          product_id: productId,
          quantity: 1
        })
      }
    );

    const data = await response.json();
    console.log('✅ Response Status:', response.status);
    console.log('✅ Response Body:', JSON.stringify(data, null, 2));

    // Check if item was added to cart_items
    console.log('\n🔍 Checking cart_items table...');
    const cartItemsRes = await db.query('SELECT id, product_id, quantity FROM cart_items LIMIT 5');
    console.log('✅ Cart Items:', cartItemsRes.rows);

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await db.closePool();
    process.exit();
  }
})();
