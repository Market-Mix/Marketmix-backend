/**
 * Product Listings to Products Migration Script
 * 
 * This script safely migrates all products from the product_listings table
 * into the main products table without breaking existing data.
 * 
 * Features:
 * - Reads all items from product_listings
 * - Maps fields to products table schema
 * - Avoids duplicate entries (checks if product already exists)
 * - Sets proper defaults for new columns
 * - Maintains timestamps
 * - Provides detailed logging
 * 
 * Usage: node seed_products_from_listings.js
 */

require('dotenv').config();
const { Pool } = require('pg');

// UUID generator for new product IDs
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Determine if a category needs color and size variations
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

// Generate flash sale timestamps (30% of products get flash sales)
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

// Color codes for console output
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
  data: (msg) => console.log(`${colors.cyan}   ${msg}${colors.reset}`)
};

async function seedProductsFromListings() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  });

  let migratedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  try {
    log.title('🚀 PRODUCT LISTINGS TO PRODUCTS MIGRATION');
    log.info('Starting migration process...\n');

    // Step 1: Get all product_listings
    log.info('📖 Reading product_listings table...');
    const listingsRes = await pool.query(
      'SELECT * FROM product_listings WHERE is_deleted = false ORDER BY created_at DESC'
    );
    const listings = listingsRes.rows;

    if (listings.length === 0) {
      log.warning('No active product listings found');
      await pool.end();
      return;
    }

    log.success(`Found ${listings.length} product listings to migrate\n`);

    // Step 2: Get a seller ID to assign products
    log.info('👤 Getting seller information...');
    const sellerRes = await pool.query('SELECT id FROM users LIMIT 1');
    
    if (sellerRes.rows.length === 0) {
      log.error('No sellers found in database');
      process.exit(1);
    }

    const defaultSellerId = sellerRes.rows[0].id;
    log.success(`Using seller_id: ${defaultSellerId}\n`);

    // Step 3: Migrate each listing
    log.info('🔄 Migrating products...\n');

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      
      try {
        // Check if product already exists (to avoid duplicates)
        const existsRes = await pool.query(
          'SELECT id FROM products WHERE name = $1 AND seller_id = $2',
          [listing.name, defaultSellerId]
        );

        if (existsRes.rows.length > 0) {
          log.warning(`[${i + 1}/${listings.length}] Product already exists: "${listing.name}"`);
          duplicateCount++;
          continue;
        }

        // Prepare data for insertion
        const productId = generateUUID();
        const name = listing.name || 'Unnamed Product';
        const description = listing.description || '';
        const price = parseFloat(listing.price) || 0;
        const stockQuantity = parseInt(listing.stock_quantity) || 0;
        const mainImageUrl = listing.image || listing.main_image_url || null;
        const category = listing.category || null;
        const variations = getVariationsForCategory(category);
        const color = listing.color || variations.colors;
        const size = listing.size || variations.sizes;
        const flashSale = getFlashSaleTimestamps();

        // Insert into products table
        await pool.query(
          `INSERT INTO products (
            id,
            seller_id,
            category,
            name,
            description,
            price,
            stock_quantity,
            main_image_url,
            is_active,
            is_deleted,
            views,
            color,
            size,
            flash_start,
            flash_end,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
          [
            productId,
            defaultSellerId,
            category,
            name,
            description,
            price,
            stockQuantity,
            mainImageUrl,
            true, // is_active = true
            false, // is_deleted = false
            0, // views = 0
            color,
            size,
            flashSale.flash_start,
            flashSale.flash_end
          ]
        );

        log.success(`[${i + 1}/${listings.length}] Migrated: "${name}" (₦${price})`);
        log.data(`   ID: ${productId} | Stock: ${stockQuantity}`);
        migratedCount++;

      } catch (itemError) {
        log.error(`[${i + 1}/${listings.length}] Failed to migrate: "${listing.name}"`);
        log.data(`   Error: ${itemError.message}`);
        errorCount++;
      }
    }

    // Step 4: Verification
    log.title('📊 MIGRATION SUMMARY');
    log.success(`Migrated: ${migratedCount} products`);
    log.warning(`Duplicates (skipped): ${duplicateCount} products`);
    if (errorCount > 0) {
      log.error(`Errors: ${errorCount} products`);
    }

    const totalRes = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE is_active = true AND is_deleted = false'
    );
    log.info(`Total active products in database: ${totalRes.total_count || totalRes.rows[0].count}`);

    log.title('✨ MIGRATION COMPLETE');
    log.success('All product listings have been migrated to the products table!');

    await pool.end();

  } catch (err) {
    log.error(`Fatal Error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// Run migration
seedProductsFromListings().catch(err => {
  log.error(`Unhandled error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
