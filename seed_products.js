require('dotenv').config();
const { Pool } = require('pg');

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
    return { colors: null, sizes: null };
  }

  const categoryLower = category.toLowerCase().trim();

  // Fashion and apparel categories
  const fashionCategories = ['fashion', 'clothing', 'apparel', 'clothes', 'dresses', 'shirts', 'pants', 'jackets'];
  if (fashionCategories.some(cat => categoryLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Black', 'Blue', 'White', 'Red', 'Gray']),
      sizes: JSON.stringify(['XS', 'S', 'M', 'L', 'XL', 'XXL'])
    };
  }

  // Shoes category
  const shoesCategories = ['shoes', 'footwear', 'sneakers', 'boots', 'sandals'];
  if (shoesCategories.some(cat => categoryLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Black', 'White', 'Brown', 'Gray', 'Navy']),
      sizes: JSON.stringify(['6', '7', '8', '9', '10', '11', '12', '13'])
    };
  }

  // Bags and accessories
  const bagsCategories = ['bags', 'bag', 'backpack', 'purse', 'wallet', 'handbag', 'tote'];
  if (bagsCategories.some(cat => categoryLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Black', 'Brown', 'Tan', 'Blue', 'Red']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  // Jewelry
  const jewelryCategories = ['jewelry', 'jewellery', 'necklace', 'bracelet', 'ring', 'earring'];
  if (jewelryCategories.some(cat => categoryLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Gold', 'Silver', 'Rose Gold', 'Platinum']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  // No variations needed (electronics, books, home, etc.)
  return { colors: null, sizes: null };
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

async function seedProducts() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  });

  try {
    // First, get a random user ID to use as seller_id
    console.log('Getting a user to assign as seller...');
    const userRes = await pool.query('SELECT id FROM users LIMIT 1');
    
    if (userRes.rows.length === 0) {
      console.log('❌ No users found in database');
      process.exit(1);
    }

    const sellerId = userRes.rows[0].id;
    console.log(`✅ Using seller_id: ${sellerId}\n`);

    const products = [
      {
        name: 'Smartphone X Pro',
        description: 'High-performance smartphone with advanced camera system',
        price: 250,
        stock_quantity: 10,
        category: 'electronics',
        main_image_url: 'https://images.unsplash.com/photo-1511707267537-b85faf00021e?w=500'
      },
      {
        name: 'Wireless Headphones',
        description: 'Premium noise-cancelling wireless headphones with 30-hour battery life',
        price: 50,
        stock_quantity: 25,
        category: 'electronics',
        main_image_url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'
      },
      {
        name: 'USB-C Charger',
        description: 'Fast-charging USB-C charger compatible with all devices',
        price: 15,
        stock_quantity: 50,
        category: 'electronics',
        main_image_url: 'https://images.unsplash.com/photo-1591290621749-2a133cd9ae63?w=500'
      },
      {
        name: 'Screen Protector Pack',
        description: 'Pack of 2 tempered glass screen protectors',
        price: 8,
        stock_quantity: 100,
        category: 'electronics',
        main_image_url: 'https://images.unsplash.com/photo-1586253408031-67b61cfbc3d1?w=500'
      }
    ];

    console.log('🌱 Seeding products...\n');
    for (const product of products) {
      const variations = getVariationsForCategory(product.category);
      const flashSale = getFlashSaleTimestamps();
      
      const flashSaleLabel = flashSale.flash_start ? ' 🔥 FLASH SALE' : '';
      
      await pool.query(
        `INSERT INTO products (id, seller_id, category, name, description, price, stock_quantity, main_image_url, color, size, flash_start, flash_end, is_active, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, false, NOW(), NOW())`,
        [generateUUID(), sellerId, product.category, product.name, product.description, product.price, product.stock_quantity, product.main_image_url, variations.colors, variations.sizes, flashSale.flash_start, flashSale.flash_end]
      );
      console.log(`✅ Inserted: ${product.name} ($${product.price})${flashSaleLabel}`);
    }

    console.log('\n📊 Verifying...');
    const countRes = await pool.query('SELECT COUNT(*) as count FROM products WHERE is_active = true AND is_deleted = false');
    console.log(`✨ Total active products: ${countRes.rows[0].count}`);

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

seedProducts();
