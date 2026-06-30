// scripts/add_vendor_orders_tracking_link.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE vendor_orders
      ADD COLUMN IF NOT EXISTS tracking_link VARCHAR(255);
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();