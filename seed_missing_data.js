require('dotenv').config();
const { Pool } = require('pg');

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Map product names to categories
const productCategoryMapping = {
  'Smartphone X Pro': 'Electronics',
  'Wireless Headphones': 'Electronics',
  'Wireless Earbuds Pro': 'Electronics',
  'USB-C Charger': 'Electronics',
  'USB-C Fast Charger': 'Electronics',
  'Screen Protector Pack': 'Electronics',
  'Premium Leather Jacket': 'Fashion',
  'Premium Wireless Headphones': 'Electronics',
};

// Sample products to seed for each empty category
const categoryProductTemplates = {
  'Fashion': {
    name: 'Premium Cotton T-Shirt',
    description: 'High-quality 100% cotton t-shirt available in multiple colors',
    price: 25.99,
    stock_quantity: 50,
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=500'
  },
  'Home & Garden': {
    name: 'Modern LED Desk Lamp',
    description: 'Adjustable brightness LED desk lamp with USB charging port',
    price: 35.00,
    stock_quantity: 30,
    image: 'https://images.unsplash.com/photo-1565636192335-14e9bcff2ead?w=500'
  },
  'Sports & Outdoors': {
    name: 'Professional Yoga Mat',
    description: 'Non-slip yoga mat with carrying strap and thickness of 6mm',
    price: 45.00,
    stock_quantity: 40,
    image: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=500'
  },
  'Books & Media': {
    name: 'Best-Selling Fiction Novel',
    description: 'Award-winning fiction novel - International bestseller',
    price: 18.99,
    stock_quantity: 100,
    image: 'https://images.unsplash.com/photo-1507842217343-583f7270bfba?w=500'
  },
  'Toys & Games': {
    name: 'Educational Board Game',
    description: 'Fun and educational board game for families - Ages 6+',
    price: 29.99,
    stock_quantity: 60,
    image: 'https://images.unsplash.com/photo-1516975080664-ed2fc6a32937?w=500'
  },
  'Health & Beauty': {
    name: 'Organic Facial Skincare Set',
    description: 'Complete skincare routine with organic natural ingredients',
    price: 55.00,
    stock_quantity: 45,
    image: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500'
  },
  'Automotive': {
    name: 'Car Phone Mount',
    description: 'Adjustable universal car phone mount for dashboard and windshield',
    price: 16.99,
    stock_quantity: 75,
    image: 'https://images.unsplash.com/photo-1605559424843-9e4c3ca4628d?w=500'
  },
  'Jewelry': {
    name: 'Sterling Silver Pendant',
    description: 'Elegant sterling silver pendant necklace with chain',
    price: 48.00,
    stock_quantity: 35,
    image: 'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=500'
  },
  'Pet Supplies': {
    name: 'Premium Dog Food',
    description: 'Nutritious premium dog food with natural ingredients - 5kg bag',
    price: 32.99,
    stock_quantity: 50,
    image: 'https://images.unsplash.com/photo-1568152950566-c1bf43f0a86d?w=500'
  }
};

async function seedMissingData() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  });

  try {
    console.log('🔍 Analyzing database...\n');

    // Get all categories
    const categoriesRes = await pool.query(
      'SELECT id, name FROM categories WHERE is_active = true AND is_deleted = false ORDER BY name'
    );
    const categories = categoriesRes.rows;
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat.name] = cat.id;
    });

    console.log(`📂 Found ${categories.length} categories:`);
    categories.forEach(cat => console.log(`   - ${cat.name} (ID: ${cat.id})`));
    console.log();

    // Get all products without category_id
    const productsRes = await pool.query(
      'SELECT id, name FROM products WHERE is_active = true AND is_deleted = false AND category_id IS NULL ORDER BY created_at DESC'
    );
    const productsWithoutCategory = productsRes.rows;

    console.log(`📦 Found ${productsWithoutCategory.length} products without category assigned`);
    if (productsWithoutCategory.length > 0) {
      productsWithoutCategory.forEach(p => console.log(`   - ${p.name} (ID: ${p.id})`));
      console.log();
    }

    // Get all products with categories
    const allProductsRes = await pool.query(
      'SELECT id, name, category_id FROM products WHERE is_active = true AND is_deleted = false ORDER BY created_at DESC'
    );
    const allProducts = allProductsRes.rows;

    // STEP 1: Assign categories to products that don't have one
    console.log('🔗 Step 1: Assigning categories to orphan products...\n');
    let categoriesAssigned = 0;

    for (const product of productsWithoutCategory) {
      // Try to find matching category based on product name
      let categoryName = null;
      for (const [prodName, catName] of Object.entries(productCategoryMapping)) {
        if (product.name.toLowerCase().includes(prodName.toLowerCase()) || 
            prodName.toLowerCase().includes(product.name.toLowerCase())) {
          categoryName = catName;
          break;
        }
      }

      if (categoryName && categoryMap[categoryName]) {
        const categoryId = categoryMap[categoryName];
        await pool.query(
          'UPDATE products SET category_id = $1, updated_at = NOW() WHERE id = $2',
          [categoryId, product.id]
        );
        console.log(`✅ "${product.name}" → ${categoryName}`);
        categoriesAssigned++;
      } else {
        console.log(`⚠️  "${product.name}" → No matching category (skipping)`);
      }
    }
    console.log(`\n✨ Assigned categories to ${categoriesAssigned} products\n`);

    // STEP 2: Find categories without products and seed them
    console.log('🌱 Step 2: Seeding products for empty categories...\n');

    const categoriesWithProductsRes = await pool.query(
      'SELECT DISTINCT category_id FROM products WHERE is_active = true AND is_deleted = false AND category_id IS NOT NULL'
    );
    const categoriesWithProducts = new Set(categoriesWithProductsRes.rows.map(r => r.category_id));

    const emptyCategories = categories.filter(cat => !categoriesWithProducts.has(cat.id));

    console.log(`📊 Categories with products: ${categoriesWithProducts.size}`);
    console.log(`📊 Empty categories: ${emptyCategories.length}`);
    if (emptyCategories.length > 0) {
      console.log('Empty categories:');
      emptyCategories.forEach(cat => console.log(`   - ${cat.name}`));
      console.log();
    }

    // Get a seller ID to use for new products
    const sellerRes = await pool.query('SELECT id FROM users LIMIT 1');
    if (sellerRes.rows.length === 0) {
      console.log('❌ No users found in database');
      process.exit(1);
    }
    const sellerId = sellerRes.rows[0].id;

    let productsSeeded = 0;
    for (const emptyCategory of emptyCategories) {
      const template = categoryProductTemplates[emptyCategory.name];
      if (template) {
        const newProductId = generateUUID();
        await pool.query(
          `INSERT INTO products (id, seller_id, category_id, name, description, price, stock_quantity, main_image_url, is_active, is_deleted, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, NOW(), NOW())`,
          [newProductId, sellerId, emptyCategory.id, template.name, template.description, template.price, template.stock_quantity, template.image]
        );
        console.log(`✅ Seeded "${template.name}" in ${emptyCategory.name}`);
        productsSeeded++;
      }
    }
    console.log(`\n✨ Seeded ${productsSeeded} products for empty categories\n`);

    // Final verification
    console.log('📊 Final Verification...\n');
    const finalCategoriesRes = await pool.query(
      'SELECT c.id, c.name, COUNT(p.id) as product_count FROM categories c LEFT JOIN products p ON c.id = p.category_id AND p.is_active = true AND p.is_deleted = false WHERE c.is_active = true AND c.is_deleted = false GROUP BY c.id, c.name ORDER BY c.name'
    );
    const finalResults = finalCategoriesRes.rows;

    let totalProducts = 0;
    let categoriesWithAtLeastOne = 0;
    finalResults.forEach(row => {
      const count = parseInt(row.product_count) || 0;
      totalProducts += count;
      if (count > 0) categoriesWithAtLeastOne++;
      const status = count > 0 ? '✅' : '⚠️ ';
      console.log(`${status} ${row.name}: ${count} product(s)`);
    });

    console.log(`\n✨ Summary:`);
    console.log(`   Total categories: ${finalResults.length}`);
    console.log(`   Categories with products: ${categoriesWithAtLeastOne}`);
    console.log(`   Total products: ${totalProducts}`);
    console.log(`   Categories still empty: ${finalResults.length - categoriesWithAtLeastOne}`);

    await pool.end();
    console.log('\n✅ Seeding complete!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
    process.exit(1);
  }
}

seedMissingData();
