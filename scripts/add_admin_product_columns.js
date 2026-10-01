require('dotenv').config();
const db = require('../config/db');

(async () => {
  await db.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS admin_disabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
      ADD COLUMN IF NOT EXISTS disabled_by UUID,
      ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMP;
  `);

  console.log('✅ done');
  await db.closePool();
  process.exit();
})();
