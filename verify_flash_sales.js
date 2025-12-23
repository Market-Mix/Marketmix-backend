require('dotenv').config();
const pool = require('./config/db');

/**
 * Script to verify that flash sales are properly configured
 */

async function verifyFlashSales() {
  try {
    console.log('🔍 Verifying Flash Sales Configuration...\n');

    // Get products with active flash sales
    const result = await pool.query(
      `SELECT id, name, price, "flash start" as flash_start, "flash end" as flash_end
       FROM products 
       WHERE is_active = true AND is_deleted = false 
       AND "flash start" IS NOT NULL AND "flash end" IS NOT NULL
       ORDER BY "flash end" ASC`
    );

    if (result.rows.length === 0) {
      console.log('⚠️ No products with flash sales found');
      process.exit(0);
    }

    console.log(`✅ Found ${result.rows.length} products with flash sales\n`);
    console.log('=' .repeat(80));
    console.log('ACTIVE FLASH SALES:');
    console.log('='.repeat(80) + '\n');

    const now = new Date();

    result.rows.forEach((product, index) => {
      const start = new Date(product.flash_start);
      const end = new Date(product.flash_end);
      const isActive = now >= start && now <= end;
      const timeRemaining = end - now;
      const hoursRemaining = (timeRemaining / (1000 * 60 * 60)).toFixed(2);

      console.log(`${index + 1}. ${product.name}`);
      console.log(`   Price: $${product.price}`);
      console.log(`   Flash Start: ${start.toLocaleString()}`);
      console.log(`   Flash End: ${end.toLocaleString()}`);
      console.log(`   Status: ${isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}`);
      console.log(`   Time Remaining: ${hoursRemaining} hours`);
      console.log('');
    });

    console.log('='.repeat(80));
    
    // Summary
    const activeCount = result.rows.filter(p => {
      const start = new Date(p.flash_start);
      const end = new Date(p.flash_end);
      return now >= start && now <= end;
    }).length;

    console.log(`\n📊 Summary:`);
    console.log(`   Total Products: ${result.rows.length}`);
    console.log(`   Currently Active: ${activeCount}`);
    console.log(`   Inactive/Expired: ${result.rows.length - activeCount}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

verifyFlashSales();
