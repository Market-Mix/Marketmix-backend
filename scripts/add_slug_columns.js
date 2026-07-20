// scripts/add_slug_columns.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS account_slug VARCHAR(60) UNIQUE;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS slug VARCHAR(80);
    CREATE UNIQUE INDEX IF NOT EXISTS stores_user_slug_uidx ON stores(user_id, slug);
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();