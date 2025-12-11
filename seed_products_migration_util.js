/**
 * Product Migration Utility
 * 
 * Provides reusable functions to migrate products from product_listings
 * to the main products table. Can be used standalone or imported into other scripts.
 * 
 * Usage:
 * // As standalone script:
 * node seed_products_migration_util.js
 * 
 * // As module import:
 * const { migrateProductsFromListings } = require('./seed_products_migration_util.js');
 * await migrateProductsFromListings(pool, options);
 */

require('dotenv').config();
const { Pool } = require('pg');

/**
 * Generate a UUID v4
 * @returns {string} UUID string
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Determine if a category needs color and size variations
 * @param {string} category - Product category
 * @returns {Object} { needsVariations: boolean, colors: array|null, sizes: array|null }
 */
function getVariationsForCategory(category) {
  if (!category) {
    return { needsVariations: false, colors: null, sizes: null };
  }

  const categoryLower = category.toLowerCase().trim();

  // Fashion and apparel categories
  const fashionCategories = ['fashion', 'clothing', 'apparel', 'clothes', 'dresses', 'shirts', 'pants', 'jackets'];
  if (fashionCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Black', 'Blue', 'White', 'Red', 'Gray']),
      sizes: JSON.stringify(['XS', 'S', 'M', 'L', 'XL', 'XXL'])
    };
  }

  // Shoes category
  const shoesCategories = ['shoes', 'footwear', 'sneakers', 'boots', 'sandals'];
  if (shoesCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Black', 'White', 'Brown', 'Gray', 'Navy']),
      sizes: JSON.stringify(['6', '7', '8', '9', '10', '11', '12', '13'])
    };
  }

  // Bags and accessories
  const bagsCategories = ['bags', 'bag', 'backpack', 'purse', 'wallet', 'handbag', 'tote'];
  if (bagsCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Black', 'Brown', 'Tan', 'Blue', 'Red']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  // Jewelry
  const jewelryCategories = ['jewelry', 'jewellery', 'necklace', 'bracelet', 'ring', 'earring'];
  if (jewelryCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Gold', 'Silver', 'Rose Gold', 'Platinum']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  // No variations needed (electronics, books, home, etc.)
  return { needsVariations: false, colors: null, sizes: null };
}

/**
 * Generate flash sale timestamps (30% of products get flash sales)
 * @returns {Object} { flash_start: timestamp|null, flash_end: timestamp|null }
 */
function getFlashSaleTimestamps() {
  // Only 30% of products will have flash sales
  if (Math.random() > 0.3) {
    return { flash_start: null, flash_end: null };
  }
  
  // Current time in UTC
  const now = new Date();
  const flashStart = new Date(now);
  
  // Flash end = NOW + 24 hours
  const flashEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  
  return {
    flash_start: flashStart.toISOString(),
    flash_end: flashEnd.toISOString()
  };
}

/**
 * Migrate products from product_listings to products table
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {Object} options - Migration options
 * @param {string} options.sellerId - Seller ID to assign to products (optional, uses first user if not provided)
 * @param {boolean} options.verbose - Enable detailed logging (default: true)
 * @param {boolean} options.dryRun - Simulate migration without making changes (default: false)
 * @returns {Promise<Object>} Migration results
 */
async function migrateProductsFromListings(pool, options = {}) {
  const {
    sellerId = null,
    verbose = true,
    dryRun = false
  } = options;

  const log = {
    info: (msg) => verbose && console.log(`ℹ️  ${msg}`),
    success: (msg) => verbose && console.log(`✅ ${msg}`),
    error: (msg) => verbose && console.log(`❌ ${msg}`),
    warning: (msg) => verbose && console.log(`⚠️  ${msg}`)
  };

  const results = {
    migratedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    errors: [],
    listings: [],
    products: [],
    isDryRun: dryRun
  };

  try {
    // Step 1: Determine seller ID
    let assignSellerId = sellerId;
    if (!assignSellerId) {
      const sellerRes = await pool.query('SELECT id FROM users LIMIT 1');
      if (sellerRes.rows.length === 0) {
        throw new Error('No sellers found in database');
      }
      assignSellerId = sellerRes.rows[0].id;
    }
    log.info(`Using seller_id: ${assignSellerId}`);

    // Step 2: Fetch all product listings
    log.info('Fetching product_listings...');
    const listingsRes = await pool.query(
      'SELECT id, name, description, price, stock_quantity, image, main_image_url, category, color, size, created_at FROM product_listings WHERE is_deleted = false ORDER BY created_at DESC'
    );
    const listings = listingsRes.rows;
    results.listings = listings;

    if (listings.length === 0) {
      log.warning('No product listings found');
      return results;
    }

    log.success(`Found ${listings.length} product listings`);

    // Step 3: Migrate each listing
    if (dryRun) {
      log.warning('DRY RUN MODE - No changes will be made');
    }

    for (const listing of listings) {
      try {
        // Check for duplicates
        const existsRes = await pool.query(
          'SELECT id FROM products WHERE name = $1 AND seller_id = $2',
          [listing.name, assignSellerId]
        );

        if (existsRes.rows.length > 0) {
          results.duplicateCount++;
          log.warning(`Product already exists: "${listing.name}"`);
          continue;
        }

        // Prepare product data
        const productId = generateUUID();
        const variations = getVariationsForCategory(listing.category);
        const flashSale = getFlashSaleTimestamps();
        
        const product = {
          id: productId,
          seller_id: assignSellerId,
          name: listing.name || 'Unnamed Product',
          description: listing.description || '',
          price: parseFloat(listing.price) || 0,
          stock_quantity: parseInt(listing.stock_quantity) || 0,
          main_image_url: listing.image || listing.main_image_url || null,
          category: listing.category || null,
          color: listing.color || variations.colors,
          size: listing.size || variations.sizes,
          flash_start: flashSale.flash_start,
          flash_end: flashSale.flash_end,
          is_active: true,
          is_deleted: false,
          views: 0,
          created_at: listing.created_at || new Date(),
          updated_at: new Date()
        };

        results.products.push(product);

        // Insert into database (unless dry run)
        if (!dryRun) {
          await pool.query(
            `INSERT INTO products (
              id, seller_id, category, name, description, price, stock_quantity,
              main_image_url, is_active, is_deleted, views, color, size, flash_start, flash_end, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              product.id,
              product.seller_id,
              product.category,
              product.name,
              product.description,
              product.price,
              product.stock_quantity,
              product.main_image_url,
              product.is_active,
              product.is_deleted,
              product.views,
              product.color,
              product.size,
              product.flash_start,
              product.flash_end,
              product.created_at,
              product.updated_at
            ]
          );
        }

        results.migratedCount++;
        log.success(`Migrated: "${product.name}" (₦${product.price})`);

      } catch (itemError) {
        results.errorCount++;
        results.errors.push({
          listing: listing.name,
          error: itemError.message
        });
        log.error(`Failed to migrate "${listing.name}": ${itemError.message}`);
      }
    }

    return results;

  } catch (error) {
    throw error;
  }
}

/**
 * Verify migration results
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<Object>} Verification results
 */
async function verifyMigration(pool) {
  const results = {
    totalListings: 0,
    totalProducts: 0,
    activeProducts: 0,
    timestamp: new Date()
  };

  try {
    const listingsRes = await pool.query(
      'SELECT COUNT(*) as count FROM product_listings WHERE is_deleted = false'
    );
    results.totalListings = parseInt(listingsRes.rows[0].count);

    const productsRes = await pool.query(
      'SELECT COUNT(*) as count FROM products'
    );
    results.totalProducts = parseInt(productsRes.rows[0].count);

    const activeRes = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE is_active = true AND is_deleted = false'
    );
    results.activeProducts = parseInt(activeRes.rows[0].count);

    return results;
  } catch (error) {
    throw error;
  }
}

// Standalone execution
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  });

  try {
    console.log('\n🚀 PRODUCT MIGRATION UTILITY\n');

    // Run migration
    const results = await migrateProductsFromListings(pool, {
      verbose: true,
      dryRun: false
    });

    // Verify
    console.log('\n📊 VERIFICATION\n');
    const verification = await verifyMigration(pool);
    console.log(`Total product listings: ${verification.totalListings}`);
    console.log(`Total products in database: ${verification.totalProducts}`);
    console.log(`Active products: ${verification.activeProducts}`);

    // Summary
    console.log('\n📈 MIGRATION SUMMARY\n');
    console.log(`✅ Migrated: ${results.migratedCount}`);
    console.log(`⚠️  Duplicates: ${results.duplicateCount}`);
    console.log(`❌ Errors: ${results.errorCount}`);

    if (results.errors.length > 0) {
      console.log('\n🔴 ERROR DETAILS:\n');
      results.errors.forEach(err => {
        console.log(`  - ${err.listing}: ${err.error}`);
      });
    }

    console.log('\n✨ Complete!\n');

    await pool.end();

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Export for module usage
module.exports = {
  generateUUID,
  migrateProductsFromListings,
  verifyMigration
};

// Run as standalone if executed directly
if (require.main === module) {
  main();
}
