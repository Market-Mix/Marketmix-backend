require('dotenv').config();
const { generateToken } = require('./utils/jwt');
const db = require('./config/db');

(async () => {
  try {
    // Get a real product from DB
    const prodRes = await db.query('SELECT id, name, stock_quantity FROM products WHERE is_active = true AND is_deleted = false LIMIT 2');
    if (prodRes.rows.length < 2) {
      console.log('❌ Not enough active products in DB to test merge (need 2)');
      process.exit(1);
    }

    const product1 = prodRes.rows[0];
    const product2 = prodRes.rows[1];

    console.log('✅ Found products:');
    console.log(`  1. ${product1.name} (${product1.id}) - stock: ${product1.stock_quantity}`);
    console.log(`  2. ${product2.name} (${product2.id}) - stock: ${product2.stock_quantity}`);

    // Get a real buyer from DB
    const userRes = await db.query("SELECT id, email FROM users WHERE role='buyer' LIMIT 1");
    if (userRes.rows.length === 0) {
      console.log('❌ No buyer users in DB');
      process.exit(1);
    }

    const buyer = userRes.rows[0];
    console.log(`\n✅ Using buyer: ${buyer.email} (${buyer.id})`);

    // Generate token for this buyer
    process.env.JWT_EXPIRE = '7d'; // ensure valid
    const token = generateToken({
      id: buyer.id,
      email: buyer.email,
      role: 'buyer'
    });
    console.log(`Token generated (first 20 chars): ${token.slice(0, 20)}...`);

    // Import the mergeCart controller
    const { mergeCart } = require('./controllers/cart.controller');

    // Simulate the local cart from localStorage
    const localCart = [
      { product_id: product1.id, quantity: 2 },
      { product_id: product2.id, quantity: 1 }
    ];

    console.log(`\n📦 Simulating local cart (as if from localStorage):`, localCart);

    // Create fake req/res
    const req = {
      user: { id: buyer.id, email: buyer.email, role: 'buyer' },
      body: { items: localCart }
    };

    const res = {
      statusCode: 200,
      data: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.data = payload;
      }
    };

    // Call mergeCart directly
    console.log(`\n🔄 Calling mergeCart controller...`);
    await mergeCart(req, res);

    console.log(`\n📊 Merge Result:`);
    console.log(`Status Code: ${res.statusCode}`);
    console.log(`Response:`, JSON.stringify(res.data, null, 2));

    if (res.statusCode === 200 && res.data.data) {
      const { mergedItems, adjustments } = res.data.data;
      console.log(`\n✅ Merge successful!`);
      console.log(`  - Merged items: ${mergedItems.length}`);
      if (adjustments && adjustments.length > 0) {
        console.log(`  - Adjustments: ${adjustments.length}`);
        adjustments.forEach(a => {
          console.log(`    • ${a.product_id}: ${a.reason || `requested ${a.requested}, adjusted to ${a.adjusted_to}`}`);
        });
      }

      // Verify items are in DB now
      console.log(`\n✅ Verifying merged items are in cart_items table...`);
      const cartRes = await db.query(
        `SELECT ci.product_id, ci.quantity FROM cart_items ci
         JOIN cart c ON ci.cart_id = c.id
         WHERE c.user_id = $1 ORDER BY ci.product_id`,
        [buyer.id]
      );
      console.log(`  Cart items for this user:`, cartRes.rows);
    } else {
      console.log(`\n❌ Merge failed with status ${res.statusCode}`);
    }

    await db.closePool();
    process.exit(0);
  } catch (err) {
    console.error('Test error:', err.message || err);
    process.exit(1);
  }
})();
