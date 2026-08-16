const db = require('../config/db');

async function addIndex() {
  try {
    await db.query(`CREATE INDEX IF NOT EXISTS idx_order_items_vendor_order ON order_items(vendor_order_id)`);
    console.log('✅ Created index idx_order_items_vendor_order');
    process.exit(0);
  } catch (err) {
    console.error('Failed to create index:', err);
    process.exit(1);
  }
}

addIndex();
