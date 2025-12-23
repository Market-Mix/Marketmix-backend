require('dotenv').config();
const pool = require('./config/db');

/**
 * Script to update flash_start and flash_end times for products
 * This will add varied flash sale durations to products
 * Some will be short-term (2-4 hours), some medium (8-12 hours), some longer (24-48 hours)
 */

async function updateFlashSales() {
  try {
    console.log('✅ Connected to database');

    // Get all products that have flash_start and flash_end columns
    const productsResult = await pool.query(
      `SELECT id, name, price FROM products WHERE is_active = true AND is_deleted = false LIMIT 20`
    );

    if (productsResult.rows.length === 0) {
      console.log('❌ No products found');
      return;
    }

    console.log(`\n📦 Found ${productsResult.rows.length} products. Updating flash sales...\n`);

    const now = new Date();
    const updates = [];

    for (let i = 0; i < productsResult.rows.length; i++) {
      const product = productsResult.rows[i];

      // Vary the duration based on product index
      // Every 3rd product gets a different duration
      let durationHours;
      if (i % 5 === 0) {
        // Short duration: 2-3 hours
        durationHours = 2 + Math.random() * 1;
      } else if (i % 5 === 1) {
        // Medium-short duration: 4-6 hours
        durationHours = 4 + Math.random() * 2;
      } else if (i % 5 === 2) {
        // Medium duration: 8-12 hours
        durationHours = 8 + Math.random() * 4;
      } else if (i % 5 === 3) {
        // Long duration: 24 hours
        durationHours = 24;
      } else {
        // Extra long: 36-48 hours
        durationHours = 36 + Math.random() * 12;
      }

      // Calculate flash_start (start now) and flash_end
      const flashStart = new Date(now);
      const flashEnd = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

      // Format for PostgreSQL (ISO 8601)
      const startStr = flashStart.toISOString();
      const endStr = flashEnd.toISOString();

      updates.push({
        id: product.id,
        name: product.name,
        price: product.price,
        startStr,
        endStr,
        durationHours: durationHours.toFixed(2)
      });

      console.log(`📝 Product ${i + 1}/${productsResult.rows.length}:`);
      console.log(`   Name: ${product.name}`);
      console.log(`   Duration: ${durationHours.toFixed(2)} hours`);
      console.log(`   Flash Start: ${startStr}`);
      console.log(`   Flash End: ${endStr}\n`);

      // Update the product
      try {
        const updateResult = await pool.query(
          `UPDATE products 
           SET "flash start" = $1, "flash end" = $2
           WHERE id = $3
           RETURNING id, name`,
          [startStr, endStr, product.id]
        );

        if (updateResult.rows.length > 0) {
          console.log(`   ✅ Updated successfully\n`);
        } else {
          console.log(`   ⚠️ Product not found for update\n`);
        }
      } catch (updateError) {
        console.log(`   ❌ Error updating: ${updateError.message}\n`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 FLASH SALES UPDATE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total products updated: ${updates.length}`);
    console.log(`\nFlash sales are now active!`);
    console.log(`When the flash_end time is reached, products will automatically`);
    console.log(`disappear from the Flash Sales section on the homepage.\n`);

    // Get updated count
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM products 
       WHERE is_active = true AND is_deleted = false 
       AND "flash start" IS NOT NULL AND "flash end" IS NOT NULL`
    );

    console.log(`✅ Total products with active flash sales: ${countResult.rows[0].count}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    console.log('\n✅ Database operation completed');
    process.exit(0);
  }
}

// Run the update
updateFlashSales();
