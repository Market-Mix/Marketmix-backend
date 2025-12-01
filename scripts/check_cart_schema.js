require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('Checking cart_items table columns...');
    const columnsRes = await db.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'cart_items' 
      ORDER BY ordinal_position
    `);
    console.log('cart_items table columns:');
    if (columnsRes.rows.length === 0) {
      console.log('❌ Table does not exist or is empty');
    } else {
      columnsRes.rows.forEach(col => {
        console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.closePool();
  }
})();
