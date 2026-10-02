require('dotenv').config();
const db = require('../config/db');

(async () => {
  await db.query(`
    ALTER TABLE payment_transactions
      ADD COLUMN IF NOT EXISTS channel VARCHAR(50),
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS raw_response JSONB;
  `);

  console.log('✅ done');
  await db.closePool();
  process.exit();
})();
