/**
 * Test Script: Verify Product Count Auto-Updates
 * 
 * This script tests the database triggers by:
 * 1. Creating a test product in a category
 * 2. Verifying the count increased
 * 3. Deleting the product
 * 4. Verifying the count decreased
 */

require('dotenv').config();
const { Pool } = require('pg');

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function testProductCountTriggers() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🧪 Testing Product Count Auto-Update Triggers\n');
    console.log('═'.repeat(60) + '\n');

    // Get a seller ID
    const sellerRes = await pool.query('SELECT id FROM users LIMIT 1');
    const sellerId = sellerRes.rows[0].id;

    // Get Electronics category
    const categoryRes = await pool.query('SELECT id, name, product_count FROM categories WHERE name = $1 LIMIT 1', ['Electronics']);
    const category = categoryRes.rows[0];
    console.log(`📂 Using Category: ${category.name}`);
    console.log(`   Current product_count: ${category.product_count}\n`);

    // Get the actual count from products table
    const actualCountRes = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE category_id = $1 AND is_active = true AND is_deleted = false',
      [category.id]
    );
    const actualCount = parseInt(actualCountRes.rows[0].count);
    console.log(`   Actual products in category: ${actualCount}\n`);

    // Test 1: Insert a test product
    console.log('📝 Test 1: Adding a test product...');
    const testProductId = generateUUID();
    const testProductName = `TEST_PRODUCT_${Date.now()}`;

    await pool.query(
      `INSERT INTO products (id, seller_id, category_id, name, description, price, stock_quantity, main_image_url, is_active, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, NOW(), NOW())`,
      [testProductId, sellerId, category.id, testProductName, 'Test product for triggers', 99.99, 10, 'https://via.placeholder.com/500']
    );
    console.log(`   ✅ Product "${testProductName}" created\n`);

    // Check the count after insertion
    const afterInsertRes = await pool.query('SELECT product_count FROM categories WHERE id = $1', [category.id]);
    const countAfterInsert = afterInsertRes.rows[0].product_count;
    console.log(`✓ Category product_count after INSERT: ${countAfterInsert}`);
    console.log(`   Expected: ${actualCount + 1}`);
    console.log(`   Status: ${countAfterInsert === actualCount + 1 ? '✅ PASS' : '❌ FAIL'}\n`);

    // Test 2: Soft delete the product (is_deleted = true)
    console.log('📝 Test 2: Soft-deleting the product...');
    await pool.query(
      'UPDATE products SET is_deleted = true, updated_at = NOW() WHERE id = $1',
      [testProductId]
    );
    console.log(`   ✅ Product marked as deleted\n`);

    // Check the count after soft delete
    const afterDeleteRes = await pool.query('SELECT product_count FROM categories WHERE id = $1', [category.id]);
    const countAfterDelete = afterDeleteRes.rows[0].product_count;
    console.log(`✓ Category product_count after soft DELETE: ${countAfterDelete}`);
    console.log(`   Expected: ${actualCount}`);
    console.log(`   Status: ${countAfterDelete === actualCount ? '✅ PASS' : '❌ FAIL'}\n`);

    // Test 3: Hard delete the product
    console.log('📝 Test 3: Hard-deleting the product...');
    await pool.query('DELETE FROM products WHERE id = $1', [testProductId]);
    console.log(`   ✅ Product hard-deleted from database\n`);

    // Check the count after hard delete
    const afterHardDeleteRes = await pool.query('SELECT product_count FROM categories WHERE id = $1', [category.id]);
    const countAfterHardDelete = afterHardDeleteRes.rows[0].product_count;
    console.log(`✓ Category product_count after hard DELETE: ${countAfterHardDelete}`);
    console.log(`   Expected: ${actualCount}`);
    console.log(`   Status: ${countAfterHardDelete === actualCount ? '✅ PASS' : '❌ FAIL'}\n`);

    // Summary
    console.log('═'.repeat(60));
    console.log('\n📊 Summary of All Categories:\n');

    const summaryRes = await pool.query(
      `SELECT c.name, c.product_count, COUNT(p.id) as actual_count
       FROM categories c
       LEFT JOIN products p ON c.id = p.category_id AND p.is_active = true AND p.is_deleted = false
       WHERE c.is_active = true AND c.is_deleted = false
       GROUP BY c.id, c.name, c.product_count
       ORDER BY c.name;`
    );

    let allCorrect = true;
    summaryRes.rows.forEach(row => {
      const actualCount = parseInt(row.actual_count) || 0;
      const storedCount = parseInt(row.product_count) || 0;
      const status = actualCount === storedCount ? '✅' : '❌';
      
      if (actualCount !== storedCount) {
        allCorrect = false;
      }
      
      console.log(`${status} ${row.name.padEnd(25)} Stored: ${storedCount}, Actual: ${actualCount}`);
    });

    console.log('\n' + '═'.repeat(60));
    if (allCorrect) {
      console.log('✨ All tests passed! Triggers are working correctly\n');
    } else {
      console.log('⚠️  Some discrepancies found. Triggers may need attention\n');
    }

    await pool.end();
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
  }
}

testProductCountTriggers();
