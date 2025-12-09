/**
 * Database Migration: Add Product Count Triggers for Categories
 * 
 * This script adds database triggers to automatically update the product_count
 * column in the categories table whenever products are added or deleted.
 */

require('dotenv').config();
const { Pool } = require('pg');

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });

  try {
    console.log('🔄 Starting migration: Adding product count triggers...\n');

    // Step 1: Create function to update product count
    const functionSQL = `
      CREATE OR REPLACE FUNCTION update_category_product_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- When a product is inserted
        IF TG_OP = 'INSERT' THEN
          UPDATE categories 
          SET product_count = (
            SELECT COUNT(*) FROM products 
            WHERE category_id = NEW.category_id 
              AND is_active = true 
              AND is_deleted = false
          ),
          updated_at = NOW()
          WHERE id = NEW.category_id;
          RETURN NEW;
        
        -- When a product is updated (e.g., category changed or deleted/restored)
        ELSIF TG_OP = 'UPDATE' THEN
          -- Update count for old category if it changed
          IF OLD.category_id IS DISTINCT FROM NEW.category_id THEN
            UPDATE categories 
            SET product_count = (
              SELECT COUNT(*) FROM products 
              WHERE category_id = OLD.category_id 
                AND is_active = true 
                AND is_deleted = false
            ),
            updated_at = NOW()
            WHERE id = OLD.category_id;
          END IF;
          
          -- Update count for new category
          UPDATE categories 
          SET product_count = (
            SELECT COUNT(*) FROM products 
            WHERE category_id = NEW.category_id 
              AND is_active = true 
              AND is_deleted = false
          ),
          updated_at = NOW()
          WHERE id = NEW.category_id;
          RETURN NEW;
        
        -- When a product is deleted
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE categories 
          SET product_count = (
            SELECT COUNT(*) FROM products 
            WHERE category_id = OLD.category_id 
              AND is_active = true 
              AND is_deleted = false
          ),
          updated_at = NOW()
          WHERE id = OLD.category_id;
          RETURN OLD;
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `;

    console.log('📝 Creating/updating trigger function...');
    await pool.query(functionSQL);
    console.log('✅ Function created successfully\n');

    // Step 2: Drop existing triggers if they exist
    console.log('🗑️  Checking for existing triggers...');
    try {
      await pool.query('DROP TRIGGER IF EXISTS update_category_count_on_product_insert ON products');
      console.log('   Removed old insert trigger');
    } catch (e) {
      console.log('   No old insert trigger to remove');
    }

    try {
      await pool.query('DROP TRIGGER IF EXISTS update_category_count_on_product_update ON products');
      console.log('   Removed old update trigger');
    } catch (e) {
      console.log('   No old update trigger to remove');
    }

    try {
      await pool.query('DROP TRIGGER IF EXISTS update_category_count_on_product_delete ON products');
      console.log('   Removed old delete trigger\n');
    } catch (e) {
      console.log('   No old delete trigger to remove\n');
    }

    // Step 3: Create trigger for INSERT
    console.log('🔔 Creating INSERT trigger...');
    await pool.query(`
      CREATE TRIGGER update_category_count_on_product_insert
      AFTER INSERT ON products
      FOR EACH ROW
      WHEN (NEW.category_id IS NOT NULL)
      EXECUTE FUNCTION update_category_product_count();
    `);
    console.log('✅ INSERT trigger created\n');

    // Step 4: Create trigger for UPDATE
    console.log('🔔 Creating UPDATE trigger...');
    await pool.query(`
      CREATE TRIGGER update_category_count_on_product_update
      AFTER UPDATE ON products
      FOR EACH ROW
      WHEN (NEW.category_id IS NOT NULL OR OLD.category_id IS NOT NULL)
      EXECUTE FUNCTION update_category_product_count();
    `);
    console.log('✅ UPDATE trigger created\n');

    // Step 5: Create trigger for DELETE
    console.log('🔔 Creating DELETE trigger...');
    await pool.query(`
      CREATE TRIGGER update_category_count_on_product_delete
      AFTER DELETE ON products
      FOR EACH ROW
      WHEN (OLD.category_id IS NOT NULL)
      EXECUTE FUNCTION update_category_product_count();
    `);
    console.log('✅ DELETE trigger created\n');

    // Step 6: Recalculate all counts
    console.log('🔄 Recalculating product counts for all categories...\n');
    const updateCountsSQL = `
      UPDATE categories
      SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = categories.id
          AND is_active = true
          AND is_deleted = false
      ),
      updated_at = NOW()
      WHERE is_active = true AND is_deleted = false;
    `;

    const result = await pool.query(updateCountsSQL);
    console.log(`✅ Updated product counts for ${result.rowCount} categories\n`);

    // Step 7: Verify the counts
    console.log('📊 Final verification of product counts:\n');
    const verifySQL = `
      SELECT c.name, c.product_count, COUNT(p.id) as actual_count
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id AND p.is_active = true AND p.is_deleted = false
      WHERE c.is_active = true AND c.is_deleted = false
      GROUP BY c.id, c.name, c.product_count
      ORDER BY c.name;
    `;

    const verifyResult = await pool.query(verifySQL);
    let allCorrect = true;

    verifyResult.rows.forEach(row => {
      const actualCount = parseInt(row.actual_count) || 0;
      const storedCount = parseInt(row.product_count) || 0;
      const status = actualCount === storedCount ? '✅' : '⚠️ ';
      
      if (actualCount !== storedCount) {
        allCorrect = false;
      }
      
      console.log(`${status} ${row.name.padEnd(25)} Stored: ${storedCount}, Actual: ${actualCount}`);
    });

    console.log('\n' + '═'.repeat(60));
    if (allCorrect) {
      console.log('✨ SUCCESS! All product counts are accurate');
    } else {
      console.log('⚠️  Some counts are out of sync. Running final correction...');
      await pool.query(updateCountsSQL);
      console.log('✅ Counts corrected');
    }
    console.log('═'.repeat(60));

    console.log('\n🎉 Migration completed successfully!\n');
    console.log('📝 Summary:');
    console.log('   • Created PL/pgSQL function to handle product count updates');
    console.log('   • Set up triggers for INSERT, UPDATE, and DELETE operations');
    console.log('   • Automatically updates product_count when:');
    console.log('     - A new product is added to a category');
    console.log('     - A product is deleted (marked as deleted or hard deleted)');
    console.log('     - A product is moved to a different category');
    console.log('     - Product is_active status changes\n');

    await pool.end();
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error('\nFull error details:');
    console.error(err);
    process.exit(1);
  }
}

runMigration();
