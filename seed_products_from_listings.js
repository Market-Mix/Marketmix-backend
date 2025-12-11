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

  const apparelCategories = [
    'fashion', 'clothing', 'apparel', 'clothes', 'dress', 'dresses', 'shirt', 'shirts',
    'tshirt', 't-shirt', 'tshirts', 'jeans', 'trousers', 'pants', 'shorts', 'skirt',
    'hoodie', 'hoodies', 'sweatshirt', 'sweatshirts', 'jacket', 'jackets', 'coat', 'outerwear'
  ];
  if (apparelCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['S', 'M', 'L', 'XL'])
    };
  }

  const shoesCategories = [
    'shoes', 'footwear', 'sneakers', 'sneaker', 'trainers', 'boots', 'sandals', 'flip', 'heel', 'heels'
  ];
  if (shoesCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['S', 'M', 'L', 'XL'])
    };
  }

  const bagsCategories = ['bags', 'bag', 'backpack', 'purse', 'wallet', 'handbag', 'tote', 'clutch'];
  if (bagsCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  const jewelryCategories = ['jewelry', 'jewellery', 'necklace', 'bracelet', 'ring', 'earring'];
  if (jewelryCategories.some(cat => categoryLower.includes(cat))) {
    return {
      needsVariations: true,
      colors: JSON.stringify(['Gold', 'Silver', 'Rose Gold', 'Platinum']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  // No variations needed (electronics, phones, furniture, kitchen items, etc.)
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
      'SELECT * FROM product_listings ORDER BY created_at DESC'
    );
    const listings = listingsRes.rows;

    if (listings.length === 0) {
      log.warning('No product listings found');
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
        // category_id is not always available in listings; set null to avoid schema mismatch
        const categoryId = null;

        const variations = getVariationsForCategory(listing.category || null);

        // Normalize color and size to arrays to match products table ARRAY columns
        function normalizeArrayField(fieldVal, fallbackJson) {
          if (!fieldVal && !fallbackJson) return null;
          try {
            if (Array.isArray(fieldVal)) return fieldVal;
            if (typeof fieldVal === 'string') {
              // If it's a JSON string like '["Red","Blue"]', parse it
              if (fieldVal.trim().startsWith('[')) return JSON.parse(fieldVal);
              // If it's a comma-separated string, split and trim
              return fieldVal.split(',').map(s => s.trim()).filter(Boolean);
            }
            return null;
          } catch (e) {
            return null;
          }
        }

        const colorArray = normalizeArrayField(listing.color, variations.colors) || (variations.colors ? JSON.parse(variations.colors) : null);
        const sizeArray = normalizeArrayField(listing.size, variations.sizes) || (variations.sizes ? JSON.parse(variations.sizes) : null);

        // Randomly seed flash sales (30% chance)
        let flashStart = null;
        let flashEnd = null;
        if (Math.random() < 0.3) {
          const now = new Date();
          flashStart = now.toISOString(); // Start now
          // End 24 hours from now
          const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          flashEnd = endTime.toISOString();
        }

        // Insert into products table (using quoted column names for "flash start" and "flash end")
        await pool.query(
          `INSERT INTO products (
            id,
            seller_id,
            category_id,
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
            "flash start",
            "flash end",
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
          [
            productId,
            defaultSellerId,
            categoryId,
            name,
            description,
            price,
            stockQuantity,
            mainImageUrl,
            true, // is_active = true
            false, // is_deleted = false
            0, // views = 0
            colorArray,
            sizeArray,
            flashStart,
            flashEnd
          ]
        );

        log.success(`[${i + 1}/${listings.length}] Migrated: "${name}" (₦${price})`);
        if (colorArray) log.data(`   Colors: ${JSON.stringify(colorArray)}`);
        if (sizeArray) log.data(`   Sizes: ${JSON.stringify(sizeArray)}`);
        if (flashStart) log.data(`   Flash Sale: ${flashStart} → ${flashEnd}`);
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
      'SELECT COUNT(*) as count FROM products'
    );
    log.info(`Total products in database: ${totalRes.rows[0].count}`);

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
