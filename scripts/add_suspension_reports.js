require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP,
      ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
      ADD COLUMN IF NOT EXISTS suspended_by UUID,
      ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;

    ALTER TABLE seller_profiles
      ADD COLUMN IF NOT EXISTS upload_restricted_until TIMESTAMP,
      ADD COLUMN IF NOT EXISTS upload_limit_per_week INT;

    CREATE TABLE IF NOT EXISTS product_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      seller_id UUID NOT NULL,
      reporter_id UUID NOT NULL REFERENCES users(id),
      reason VARCHAR(50) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(product_id, reporter_id)
    );

    CREATE TABLE IF NOT EXISTS store_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      seller_id UUID NOT NULL,
      reporter_id UUID NOT NULL REFERENCES users(id),
      reason VARCHAR(50) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(store_id, reporter_id)
    );

    CREATE TABLE IF NOT EXISTS auto_moderation_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_type VARCHAR(20) NOT NULL, -- 'product' | 'store'
      target_id UUID NOT NULL,
      seller_id UUID NOT NULL,
      report_count INT NOT NULL,
      action_taken TEXT NOT NULL,
      admin_reviewed BOOLEAN DEFAULT false,
      reviewed_by UUID,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_product_reports_product ON product_reports(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_store_reports_store ON store_reports(store_id, created_at);
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();