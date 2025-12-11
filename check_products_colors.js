require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Check products with T-Shirt in name
    console.log('\n=== Products with T-Shirt ===');
    const tshirtRes = await pool.query(
      'SELECT name, category_id, color, size FROM products WHERE name ILIKE $1 LIMIT 5',
      ['%cotton%']
    );
    console.log(`Found ${tshirtRes.rows.length} products`);
    tshirtRes.rows.forEach(r => {
      console.log(`\nName: ${r.name}`);
      console.log(`Category ID: ${r.category_id}`);
      console.log(`Color: ${JSON.stringify(r.color)}`);
      console.log(`Size: ${JSON.stringify(r.size)}`);
    });

    // Check flash sale info
    console.log('\n=== Flash Sale Status ===');
    const flashRes = await pool.query(
      'SELECT name, "flash start", "flash end" FROM products LIMIT 10'
    );
    console.log(`Total products checked: ${flashRes.rows.length}`);
    const withFlash = flashRes.rows.filter(r => r['flash start'] !== null);
    console.log(`Products with flash sale: ${withFlash.length}`);
    if (withFlash.length > 0) {
      console.log('\nSample flash sales:');
      withFlash.slice(0, 3).forEach(r => {
        console.log(`  ${r.name}: ${r['flash start']} → ${r['flash end']}`);
      });
    }

    // Show all products summary
    console.log('\n=== Products Summary ===');
    const summaryRes = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN color IS NOT NULL THEN 1 END) as with_colors,
        COUNT(CASE WHEN size IS NOT NULL THEN 1 END) as with_sizes,
        COUNT(CASE WHEN "flash start" IS NOT NULL THEN 1 END) as with_flash_sale
      FROM products
    `);
    const summary = summaryRes.rows[0];
    console.log(`Total products: ${summary.total}`);
    console.log(`With colors: ${summary.with_colors}`);
    console.log(`With sizes: ${summary.with_sizes}`);
    console.log(`With flash sale: ${summary.with_flash_sale}`);

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
