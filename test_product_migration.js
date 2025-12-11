/**
 * Product Migration Test Script
 * 
 * This script tests the migration functionality without making changes
 * Run this before running the actual migration to verify everything works
 * 
 * Usage: node test_product_migration.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { migrateProductsFromListings, verifyMigration } = require('./seed_products_migration_util.js');

// Color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

const log = {
  title: (msg) => console.log(`\n${colors.bold}${colors.cyan}${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  section: (msg) => console.log(`\n${colors.cyan}━━ ${msg} ━━${colors.reset}`)
};

async function testMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  });

  try {
    log.title('🧪 PRODUCT MIGRATION TEST SUITE');

    // Test 1: Database Connection
    log.section('Test 1: Database Connection');
    try {
      const result = await pool.query('SELECT NOW()');
      log.success('Connected to database');
      log.info(`Server time: ${result.rows[0].now}`);
    } catch (err) {
      log.error('Failed to connect to database');
      log.error(`Error: ${err.message}`);
      process.exit(1);
    }

    // Test 2: Table Existence
    log.section('Test 2: Table Verification');
    try {
      const tablesRes = await pool.query(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' AND table_name IN ('product_listings', 'products')`
      );
      const tables = tablesRes.rows.map(r => r.table_name);
      
      if (!tables.includes('product_listings')) {
        log.warning('product_listings table not found');
      } else {
        log.success('product_listings table exists');
      }
      
      if (!tables.includes('products')) {
        log.warning('products table not found');
      } else {
        log.success('products table exists');
      }
    } catch (err) {
      log.error(`Failed to check tables: ${err.message}`);
    }

    // Test 3: Data Availability
    log.section('Test 3: Data Availability');
    try {
      const listingsRes = await pool.query('SELECT COUNT(*) as count FROM product_listings WHERE is_deleted = false');
      const listingCount = parseInt(listingsRes.rows[0].count);
      
      if (listingCount === 0) {
        log.warning('No product listings found (migration will have nothing to do)');
      } else {
        log.success(`Found ${listingCount} product listings ready for migration`);
      }

      const productsRes = await pool.query('SELECT COUNT(*) as count FROM products WHERE is_active = true AND is_deleted = false');
      const productCount = parseInt(productsRes.rows[0].count);
      log.info(`Current products in database: ${productCount}`);
    } catch (err) {
      log.error(`Failed to check data: ${err.message}`);
    }

    // Test 4: Seller Availability
    log.section('Test 4: Seller/User Availability');
    try {
      const usersRes = await pool.query('SELECT COUNT(*) as count FROM users');
      const userCount = parseInt(usersRes.rows[0].count);
      
      if (userCount === 0) {
        log.error('No users found - migration will fail (needs seller_id)');
      } else {
        log.success(`Found ${userCount} user(s) available for seller assignment`);
        const firstUserRes = await pool.query('SELECT id, email FROM users LIMIT 1');
        if (firstUserRes.rows.length > 0) {
          log.info(`Will use user: ${firstUserRes.rows[0].email}`);
        }
      }
    } catch (err) {
      log.error(`Failed to check users: ${err.message}`);
    }

    // Test 5: Sample Data Inspection
    log.section('Test 5: Sample Product Listing');
    try {
      const sampleRes = await pool.query('SELECT id, name, price, stock_quantity, image FROM product_listings LIMIT 1');
      if (sampleRes.rows.length > 0) {
        const sample = sampleRes.rows[0];
        log.success('Sample product listing:');
        log.info(`  Name: ${sample.name}`);
        log.info(`  Price: ${sample.price}`);
        log.info(`  Stock: ${sample.stock_quantity}`);
        log.info(`  Image: ${sample.image ? '✓ Set' : '✗ Not set'}`);
      }
    } catch (err) {
      log.warning(`Could not fetch sample: ${err.message}`);
    }

    // Test 6: Dry Run Migration
    log.section('Test 6: Dry Run Migration (No Changes Made)');
    try {
      log.info('Running migration in dry-run mode...');
      const dryRunResults = await migrateProductsFromListings(pool, {
        verbose: false,
        dryRun: true
      });

      log.success(`Would migrate: ${dryRunResults.migratedCount} products`);
      if (dryRunResults.duplicateCount > 0) {
        log.warning(`Duplicates to skip: ${dryRunResults.duplicateCount}`);
      }
      if (dryRunResults.errorCount > 0) {
        log.error(`Errors encountered: ${dryRunResults.errorCount}`);
        dryRunResults.errors.forEach(err => {
          log.error(`  - ${err.listing}: ${err.error}`);
        });
      }

      if (dryRunResults.products.length > 0) {
        log.info('Sample of products to be migrated:');
        dryRunResults.products.slice(0, 3).forEach(p => {
          log.info(`  • ${p.name} (₦${p.price}) - Stock: ${p.stock_quantity}`);
        });
        if (dryRunResults.products.length > 3) {
          log.info(`  ... and ${dryRunResults.products.length - 3} more`);
        }
      }
    } catch (err) {
      log.error(`Dry run failed: ${err.message}`);
    }

    // Test 7: Schema Compatibility
    log.section('Test 7: Schema Compatibility Check');
    try {
      const productsSchemaRes = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns 
         WHERE table_name = 'products' ORDER BY ordinal_position`
      );
      
      const requiredColumns = [
        'id', 'seller_id', 'name', 'price', 'stock_quantity', 
        'main_image_url', 'is_active', 'is_deleted', 'views'
      ];

      const availableColumns = productsSchemaRes.rows.map(r => r.column_name);
      let allPresent = true;

      requiredColumns.forEach(col => {
        if (availableColumns.includes(col)) {
          log.success(`Column present: ${col}`);
        } else {
          log.warning(`Column missing: ${col}`);
          allPresent = false;
        }
      });

      if (allPresent) {
        log.success('✓ All required columns are present');
      }
    } catch (err) {
      log.warning(`Could not verify schema: ${err.message}`);
    }

    // Test 8: Final Verification
    log.section('Test 8: Migration Readiness');
    try {
      const verification = await verifyMigration(pool);
      log.info('Current database state:');
      log.info(`  Product listings: ${verification.totalListings}`);
      log.info(`  Total products: ${verification.totalProducts}`);
      log.info(`  Active products: ${verification.activeProducts}`);

      if (verification.totalListings > 0) {
        log.success('✓ Ready to migrate!');
      } else {
        log.warning('No listings to migrate');
      }
    } catch (err) {
      log.error(`Verification failed: ${err.message}`);
    }

    // Summary
    log.title('✨ TEST COMPLETE');
    log.success('All tests completed!');
    log.info('\nNext steps:');
    log.info('1. Review the test results above');
    log.info('2. If all checks pass, run: npm run seed:migrate');
    log.info('3. For help, see: PRODUCT_MIGRATION_GUIDE.md');

    await pool.end();

  } catch (error) {
    log.error(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

// Run tests
testMigration();
