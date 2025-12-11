require('dotenv').config();
const { Pool } = require('pg');

function getVariationsForCategory(text) {
  if (!text) return { colors: null, sizes: null };

  const txt = text.toLowerCase();

  // Broader keyword sets covering apparel, footwear, bags, accessories, jewelry
  const apparelKeywords = ['fashion','clothing','apparel','clothes','dress','dresses','shirt','shirts','tshirt','t-shirt','tshirts','tee','cotton','hoodie','hoodies','sweatshirt','jacket','jeans','trousers','pants','shorts','skirt'];
  const footwearKeywords = ['shoe','shoes','footwear','sneaker','sneakers','trainers','boots','sandals','flip','heel','heels','sock','socks'];
  const bagsKeywords = ['bag','bags','backpack','purse','wallet','handbag','tote','clutch','satchel'];
  const jewelryKeywords = ['jewelry','jewellery','necklace','bracelet','ring','earring','pendant','silver','gold','sterling'];

  if (apparelKeywords.some(k => txt.includes(k))) {
    return { colors: JSON.stringify(['Red','Blue','Black','White']), sizes: JSON.stringify(['S','M','L','XL']) };
  }

  if (footwearKeywords.some(k => txt.includes(k))) {
    return { colors: JSON.stringify(['Black','White','Brown','Navy']), sizes: JSON.stringify(['6','7','8','9','10','11','12']) };
  }

  if (bagsKeywords.some(k => txt.includes(k))) {
    return { colors: JSON.stringify(['Black','Brown','Tan','Blue','Red']), sizes: JSON.stringify(['One Size']) };
  }

  if (jewelryKeywords.some(k => txt.includes(k))) {
    return { colors: JSON.stringify(['Gold','Silver','Rose Gold','Platinum']), sizes: JSON.stringify(['One Size']) };
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

    // Get all products (include existing color/size/flash fields so we don't overwrite present data)
    const productsRes = await pool.query('SELECT id, name, category_id, color, size, "flash start" as flash_start, "flash end" as flash_end FROM products ORDER BY name');
    const products = productsRes.rows;

    console.log(`Found ${products.length} products to update\n`);

    let updatedCount = 0;

    for (const product of products) {
      // If product already has both color and size, skip unless absent
      const needsColor = !product.color || (Array.isArray(product.color) && product.color.length === 0);
      const needsSize = !product.size || (Array.isArray(product.size) && product.size.length === 0);
      const needsFlash = !product.flash_start;

      if (!needsColor && !needsSize && !needsFlash) {
        continue; // nothing to do
      }

      // Try to get category name if available to broaden detection
      let categoryName = '';
      if (product.category_id) {
        try {
          const catRes = await pool.query('SELECT name FROM categories WHERE id = $1 LIMIT 1', [product.category_id]);
          if (catRes.rows.length > 0) categoryName = catRes.rows[0].name || '';
        } catch (e) {
          // ignore
        }
      }

      const detectText = `${product.name || ''} ${categoryName}`;
      const variations = getVariationsForCategory(detectText);

      // Parse JSON strings back to arrays for DB
      const colorArray = needsColor ? (variations.colors ? JSON.parse(variations.colors) : null) : product.color;
      const sizeArray = needsSize ? (variations.sizes ? JSON.parse(variations.sizes) : null) : product.size;

      // Randomly assign flash sale (30% chance) only if missing
      let flashStart = product.flash_start || null;
      let flashEnd = product.flash_end || null;
      if (needsFlash && Math.random() < 0.3) {
        const now = new Date();
        flashStart = now.toISOString();
        const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        flashEnd = endTime.toISOString();
      }

      // Build update query dynamically (only update fields we changed)
      const updates = [];
      const params = [];
      let idx = 1;

      if (needsColor) {
        updates.push(`color = $${idx++}`);
        params.push(colorArray);
      }
      if (needsSize) {
        updates.push(`size = $${idx++}`);
        params.push(sizeArray);
      }
      if (needsFlash) {
        updates.push(`"flash start" = $${idx++}`);
        updates.push(`"flash end" = $${idx++}`);
        params.push(flashStart);
        params.push(flashEnd);
      }

      if (updates.length === 0) continue;

      updates.push('updated_at = NOW()');
      const sql = `UPDATE products SET ${updates.join(', ')} WHERE id = $${idx}`;
      params.push(product.id);

      await pool.query(sql, params);

      const hasFlash = flashStart ? ' 🔥' : '';
      const hasColors = needsColor && colorArray ? ` (colors: ${JSON.stringify(colorArray)})` : '';
      const hasSizes = needsSize && sizeArray ? ` (sizes: ${JSON.stringify(sizeArray)})` : '';

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
