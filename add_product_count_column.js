/**
 * Database Migration: Add product_count column to categories table
 */

require('dotenv').config();
const { Pool } = require('pg');

async function addProductCountColumn() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Starting migration: Adding product_count column...\n');

    // Check if column already exists
    console.log('🔍 Checking if column already exists...');
    const checkColumnSQL = `
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'categories' AND column_name = 'product_count'
    `;
    const checkResult = await pool.query(checkColumnSQL);
    
    if (checkResult.rows.length > 0) {
      console.log('✅ Column product_count already exists\n');
      await pool.end();
      return;
    }

    console.log('➕ Adding product_count column to categories table...\n');

    // Add the column
    const addColumnSQL = `
      ALTER TABLE categories 
      ADD COLUMN product_count INTEGER DEFAULT 0 NOT NULL;
    `;
    
    await pool.query(addColumnSQL);
    console.log('✅ Column added successfully\n');

    // Initialize counts for all categories
    console.log('🔄 Initializing product counts...\n');
    const initCountSQL = `
      UPDATE categories
      SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = categories.id
          AND is_active = true
          AND is_deleted = false
      )
      WHERE is_active = true AND is_deleted = false;
    `;

    const result = await pool.query(initCountSQL);
    console.log(`✅ Initialized product counts for ${result.rowCount} categories\n`);

    // Verify the counts
    console.log('📊 Current product counts:\n');
    const verifySQL = `
      SELECT c.name, c.product_count, COUNT(p.id) as actual_count
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id AND p.is_active = true AND p.is_deleted = false
      WHERE c.is_active = true AND c.is_deleted = false
      GROUP BY c.id, c.name, c.product_count
      ORDER BY c.name;
    `;

    const verifyResult = await pool.query(verifySQL);
    verifyResult.rows.forEach(row => {
      const actual = parseInt(row.actual_count) || 0;
      const status = actual.toString() === row.product_count.toString() ? '✅' : '⚠️ ';
      console.log(`${status} ${row.name.padEnd(25)} → ${row.product_count} product(s)`);
    });

    console.log('\n✨ Migration completed successfully!\n');
    await pool.end();
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  }
}

addProductCountColumn();
