require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('🔍 Testing cart functionality directly on database...\n');

    // Get first user
    const userRes = await db.query('SELECT id, email FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      console.error('❌ No users found');
      process.exit(1);
    }
    
    const userId = userRes.rows[0].id;
    console.log('✅ Test User:', userRes.rows[0].email);

    // Get or create cart for this user
    let cartRes = await db.query(
      'SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1', 
      [userId]
    );
    let cartId;
    
    if (cartRes.rows.length === 0) {
      const createRes = await db.query(
        'INSERT INTO cart (user_id, cart_type, is_active, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id',
        [userId, 'shopping', true, false]
      );
      cartId = createRes.rows[0].id;
      console.log('✅ Created new cart:', cartId);
    } else {
      cartId = cartRes.rows[0].id;
      console.log('✅ Using existing cart:', cartId);
    }

    // Get first product
    const productRes = await db.query('SELECT id, name, stock_quantity FROM products LIMIT 1');
    if (productRes.rows.length === 0) {
      console.error('❌ No products found');
      process.exit(1);
    }
    
    const productId = productRes.rows[0].id;
    const productName = productRes.rows[0].name;
    console.log('✅ Test Product:', productName, '(stock:', productRes.rows[0].stock_quantity + ')');

    // Add item to cart
    console.log('\n🧪 Inserting item into cart_items...');
    const insertRes = await db.query(
      'INSERT INTO cart_items (cart_id, product_id, quantity, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, quantity',
      [cartId, productId, 1]
    );
    console.log('✅ Inserted cart item:', insertRes.rows[0]);

    // Verify it was inserted
    console.log('\n🔍 Verifying cart_items...');
    const verifyRes = await db.query(
      `SELECT ci.id, ci.product_id, p.name, ci.quantity
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = $1`,
      [cartId]
    );
    console.log('✅ Cart contents:');
    verifyRes.rows.forEach(item => {
      console.log(`   - ${item.name}: quantity ${item.quantity}`);
    });

    console.log('\n✅ Database operations successful! The schema is now working correctly.');

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
  } finally {
    await db.closePool();
    process.exit();
  }
})();
