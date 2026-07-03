// scripts/add_seller_price_column.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_price NUMERIC(12,2);`);
  console.log('✅ done'); await db.closePool(); process.exit();
})();