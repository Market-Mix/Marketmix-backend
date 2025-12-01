const db = require('./config/db');

async function testProductsAPI() {
  try {
    console.log('🔍 Testing Products API...\n');

    // Test 1: Check if products table exists and has rows
    console.log('1️⃣  Fetching all products from DB...');
    const allResult = await db.query(
      `SELECT id, name, price, is_active, is_deleted FROM products LIMIT 5`
    );
    console.log(`   Found ${allResult.rows.length} products (limit 5):`);
    allResult.rows.forEach(p => {
      console.log(`   - ${p.name} (id: ${p.id}, active: ${p.is_active}, deleted: ${p.is_deleted})`);
    });

    // Test 2: Check active products only
    console.log('\n2️⃣  Fetching active products (is_active=true, is_deleted=false)...');
    const activeResult = await db.query(
      `SELECT id, name, price, stock_quantity, main_image_url, is_active 
       FROM products 
       WHERE is_active = true AND is_deleted = false
       ORDER BY created_at DESC
       LIMIT 10`
    );
    console.log(`   Found ${activeResult.rows.length} active products:`);
    activeResult.rows.forEach(p => {
      console.log(`   - ${p.name} ($${p.price}, stock: ${p.stock_quantity})`);
    });

    // Test 3: Check total count
    console.log('\n3️⃣  Total product count...');
    const countResult = await db.query(
      `SELECT COUNT(*) FROM products`
    );
    console.log(`   Total products in DB: ${countResult.rows[0].count}`);

    const activeCountResult = await db.query(
      `SELECT COUNT(*) FROM products WHERE is_active = true AND is_deleted = false`
    );
    console.log(`   Active products: ${activeCountResult.rows[0].count}`);

    console.log('\n✅ Database test complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testProductsAPI();
