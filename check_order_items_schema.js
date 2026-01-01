require('dotenv').config();
const db = require('./config/db');

(async () => {
  try {
    const res = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'order_items'
      ORDER BY ordinal_position
    `);
    console.log('📋 order_items table columns:');
    res.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
    });
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.closePool();
  }
})();
