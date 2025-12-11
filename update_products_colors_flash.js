require('dotenv').config();
const { Pool } = require('pg');

function getVariationsForCategory(name, categoryId) {
  if (!name) return { colors: null, sizes: null };

  const nameLower = name.toLowerCase().trim();

  const apparelCategories = [
    'fashion', 'clothing', 'apparel', 'clothes', 'dress', 'dresses', 'shirt', 'shirts',
    'tshirt', 't-shirt', 'tshirts', 'jeans', 'trousers', 'pants', 'shorts', 'skirt',
    'hoodie', 'hoodies', 'sweatshirt', 'sweatshirts', 'jacket', 'jackets', 'coat', 'outerwear', 'cotton', 't-shirt'
  ];
  if (apparelCategories.some(cat => nameLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['S', 'M', 'L', 'XL'])
    };
  }

  const shoesCategories = [
    'shoes', 'footwear', 'sneakers', 'sneaker', 'trainers', 'boots', 'sandals', 'flip', 'heel', 'heels'
  ];
  if (shoesCategories.some(cat => nameLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['S', 'M', 'L', 'XL'])
    };
  }

  const bagsCategories = ['bags', 'bag', 'backpack', 'purse', 'wallet', 'handbag', 'tote', 'clutch'];
  if (bagsCategories.some(cat => nameLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Red', 'Blue', 'Black', 'White']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  const jewelryCategories = ['jewelry', 'jewellery', 'necklace', 'bracelet', 'ring', 'earring', 'pendant', 'silver', 'gold'];
  if (jewelryCategories.some(cat => nameLower.includes(cat))) {
    return {
      colors: JSON.stringify(['Gold', 'Silver', 'Rose Gold', 'Platinum']),
      sizes: JSON.stringify(['One Size'])
    };
  }

  return { colors: null, sizes: null };
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('\n🔄 UPDATING EXISTING PRODUCTS WITH COLORS/SIZES AND FLASH SALES\n');

    // Get all products
    const productsRes = await pool.query('SELECT id, name, category_id FROM products ORDER BY name');
    const products = productsRes.rows;

    console.log(`Found ${products.length} products to update\n`);

    let updatedCount = 0;

    for (const product of products) {
      // Get variations based on name
      const variations = getVariationsForCategory(product.name, product.category_id);

      // Randomly assign flash sale (30% chance)
      let flashStart = null;
      let flashEnd = null;
      if (Math.random() < 0.3) {
        const now = new Date();
        flashStart = now.toISOString();
        const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        flashEnd = endTime.toISOString();
      }

      // Parse JSON strings back to arrays for DB
      const colorArray = variations.colors ? JSON.parse(variations.colors) : null;
      const sizeArray = variations.sizes ? JSON.parse(variations.sizes) : null;

      // Update product
      await pool.query(
        `UPDATE products 
         SET color = $1, size = $2, "flash start" = $3, "flash end" = $4, updated_at = NOW()
         WHERE id = $5`,
        [colorArray, sizeArray, flashStart, flashEnd, product.id]
      );

      const hasFlash = flashStart ? ' 🔥' : '';
      const hasColors = colorArray ? ` (colors: ${JSON.stringify(colorArray)})` : '';
      const hasSizes = sizeArray ? ` (sizes: ${JSON.stringify(sizeArray)})` : '';

      console.log(`✅ Updated: "${product.name}"${hasColors}${hasSizes}${hasFlash}`);
      updatedCount++;
    }

    console.log(`\n✨ Updated ${updatedCount} products\n`);

    // Show summary
    const summaryRes = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN color IS NOT NULL THEN 1 END) as with_colors,
        COUNT(CASE WHEN size IS NOT NULL THEN 1 END) as with_sizes,
        COUNT(CASE WHEN "flash start" IS NOT NULL THEN 1 END) as with_flash_sale
      FROM products
    `);
    const summary = summaryRes.rows[0];
    console.log('📊 SUMMARY:');
    console.log(`   Total products: ${summary.total}`);
    console.log(`   With colors: ${summary.with_colors}`);
    console.log(`   With sizes: ${summary.with_sizes}`);
    console.log(`   With flash sale: ${summary.with_flash_sale}\n`);

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
