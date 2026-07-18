// scripts/fix_dual_store_columns.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
    ALTER TABLE earnings           ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
    ALTER TABLE withdrawals        ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  `);
  // Backfill from order_items -> vendor_orders -> store_id, for existing rows
  await db.query(`
    UPDATE escrow_transactions et SET store_id = oi.store_id
    FROM order_items oi
    WHERE oi.order_id = et.order_id AND oi.seller_id = et.seller_id AND et.store_id IS NULL;
  `);
  await db.query(`
    UPDATE earnings e SET store_id = oi.store_id
    FROM order_items oi
    WHERE oi.id = e.order_item_id AND e.store_id IS NULL;
  `);
  console.log('✅ dual-store columns fixed + backfilled');
  await db.closePool(); process.exit();
})();