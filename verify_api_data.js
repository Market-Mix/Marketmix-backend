require('dotenv').config();
const pool = require('./config/db');

(async () => {
  try {
    console.log('\n✅ PRODUCTS API DATA VERIFICATION\n');

    // Check color/size/flash data
    const res = await pool.query(`
      SELECT id, name, color, size, "flash start" as flash_start, "flash end" as flash_end 
      FROM products 
      WHERE color IS NOT NULL OR size IS NOT NULL OR "flash start" IS NOT NULL
      LIMIT 5
    `);

    console.log(`Found ${res.rows.length} products with colors/sizes/flash sales:\n`);
    
    res.rows.forEach((r, idx) => {
      console.log(`${idx + 1}. ${r.name}`);
      if (r.color) console.log(`   Colors: ${JSON.stringify(r.color)}`);
      if (r.size) console.log(`   Sizes: ${JSON.stringify(r.size)}`);
      if (r.flash_start) {
        const now = new Date();
        const end = new Date(r.flash_end);
        const isActive = now < end;
        console.log(`   Flash Sale: ${isActive ? '✅ ACTIVE' : '❌ EXPIRED'} (${r.flash_start} → ${r.flash_end})`);
      }
      console.log();
    });

    // Overall stats
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN color IS NOT NULL THEN 1 END) as with_colors,
        COUNT(CASE WHEN size IS NOT NULL THEN 1 END) as with_sizes,
        COUNT(CASE WHEN "flash start" IS NOT NULL THEN 1 END) as with_flash_sales
      FROM products
    `);

    console.log('📊 OVERALL STATISTICS:');
    console.log(`   Total products: ${stats.rows[0].total}`);
    console.log(`   With colors: ${stats.rows[0].with_colors}`);
    console.log(`   With sizes: ${stats.rows[0].with_sizes}`);
    console.log(`   With flash sales: ${stats.rows[0].with_flash_sales}\n`);

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
