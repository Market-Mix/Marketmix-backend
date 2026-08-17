// scripts/fix_seller_debts_columns.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE seller_debts
      ADD COLUMN IF NOT EXISTS original_debt NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS remaining_debt NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_case_id UUID,
      ADD COLUMN IF NOT EXISTS refund_transaction_id UUID,
      ADD COLUMN IF NOT EXISTS reason TEXT;
  `);
  // backfill from legacy 'amount' column if it has data and remaining_debt is still 0
  await db.query(`
    UPDATE seller_debts
    SET original_debt = amount, remaining_debt = amount
    WHERE amount IS NOT NULL AND remaining_debt = 0 AND original_debt = 0;
  `).catch(() => {}); // ignore if 'amount' column doesn't exist
  console.log('✅ seller_debts columns fixed');
  await db.closePool(); process.exit();
})();