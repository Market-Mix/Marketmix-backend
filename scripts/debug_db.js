require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('🔍 Checking products table...');
    const productsRes = await db.query(`
      SELECT id, name, price, stock_quantity, main_image_url, is_active, is_deleted 
      FROM products 
      LIMIT 5
    `);
    console.log('✅ Products in DB:', productsRes.rows);

    console.log('\n🔍 Checking cart_items table...');
    const cartRes = await db.query(`
      SELECT id, user_id, product_id, quantity, created_at 
      FROM cart_items 
      LIMIT 5
    `);
    console.log('✅ Cart items in DB:', cartRes.rows);

    console.log('\n🔍 Checking users table...');
    const usersRes = await db.query('SELECT id, email, role FROM users LIMIT 5');
    console.log('✅ Users in DB:', usersRes.rows);

    console.log('\n🔍 Checking products table columns...');
    const columnsRes = await db.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'products' 
      ORDER BY ordinal_position
    `);
    console.log('✅ Products table columns:');
    columnsRes.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await db.closePool();
    process.exit();
  }
})();
