// scripts/add_password_reset_columns.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255),
      ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP;
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();