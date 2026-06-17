// scripts/add_sendbox_columns.js — run once
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE vendor_orders
      ADD COLUMN IF NOT EXISTS tracking_code VARCHAR(50),
      ADD COLUMN IF NOT EXISTS courier_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS shipment_status VARCHAR(30),
      ADD COLUMN IF NOT EXISTS sendbox_shipment_id VARCHAR(50);
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();