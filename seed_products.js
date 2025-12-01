require('dotenv').config();
const { Pool } = require('pg');

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
        main_image_url: 'https://images.unsplash.com/photo-1511707267537-b85faf00021e?w=500'
      },
      {
        name: 'Wireless Headphones',
        description: 'Premium noise-cancelling wireless headphones with 30-hour battery life',
        price: 50,
        stock_quantity: 25,
        main_image_url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'
      },
      {
        name: 'USB-C Charger',
        description: 'Fast-charging USB-C charger compatible with all devices',
        price: 15,
        stock_quantity: 50,
        main_image_url: 'https://images.unsplash.com/photo-1591290621749-2a133cd9ae63?w=500'
      },
      {
        name: 'Screen Protector Pack',
        description: 'Pack of 2 tempered glass screen protectors',
        price: 8,
        stock_quantity: 100,
        main_image_url: 'https://images.unsplash.com/photo-1586253408031-67b61cfbc3d1?w=500'
      }
    ];

    console.log('🌱 Seeding products...\n');
    for (const product of products) {
      await pool.query(
        `INSERT INTO products (id, seller_id, name, description, price, stock_quantity, main_image_url, is_active, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, false, NOW(), NOW())`,
        [generateUUID(), sellerId, product.name, product.description, product.price, product.stock_quantity, product.main_image_url]
      );
      console.log(`✅ Inserted: ${product.name} ($${product.price})`);
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
