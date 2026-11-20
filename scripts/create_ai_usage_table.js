require('dotenv').config();
const db = require('../config/db');

async function createAiUsageTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID NOT NULL REFERENCES users(id),
        task VARCHAR(40) NOT NULL,
        tokens INT DEFAULT 0,
        status VARCHAR(10) NOT NULL DEFAULT 'ok',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_seller_day
      ON ai_usage(seller_id, created_at DESC);
    `);
    console.log('✅ ai_usage ready');
  } finally {
    await db.closePool();
  }
}

createAiUsageTable().catch((error) => {
  console.error('❌ Failed to create ai_usage:', error.message);
  process.exitCode = 1;
});
