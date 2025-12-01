require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('Updating product image URLs...');
    
    const imageUpdates = [
      {
        id: 'c7ca4e1b-80bb-45dc-9839-6a66ff115a30',
        url: 'https://images.unsplash.com/photo-1511707267537-b85faf00021e?w=300&h=300&fit=crop'
      },
      {
        id: '5956d9d1-3671-4651-ad88-c5756303f7f6',
        url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=300&h=300&fit=crop'
      }
    ];

    for (const update of imageUpdates) {
      const result = await db.query(
        'UPDATE products SET main_image_url = $1 WHERE id = $2 RETURNING id, name, main_image_url',
        [update.url, update.id]
      );
      if (result.rows.length > 0) {
        console.log(`✅ Updated: ${result.rows[0].name}`);
      }
    }

    console.log('\n✅ All images updated!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.closePool();
    process.exit();
  }
})();
