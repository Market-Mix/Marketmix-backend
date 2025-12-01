require('dotenv').config();
const { Pool } = require('pg');

async function checkProducts() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4
  });

  try {
    console.log('Checking products...\n');

    // Check all products
    const res1 = await pool.query('SELECT COUNT(*) as total FROM products');
    console.log(`Total products: ${res1.rows[0].total}`);

    // Check active products
    const res2 = await pool.query(
      'SELECT COUNT(*) as active FROM products WHERE is_active = true AND is_deleted = false'
    );
    console.log(`Active products: ${res2.rows[0].active}`);

    // Show first 5 products
    const res3 = await pool.query(
      'SELECT id, name, is_active, is_deleted FROM products LIMIT 5'
    );
    console.log(`\nFirst 5 products:`);
    res3.rows.forEach(p => {
      console.log(`  - ${p.name} (active: ${p.is_active}, deleted: ${p.is_deleted})`);
    });

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkProducts();
