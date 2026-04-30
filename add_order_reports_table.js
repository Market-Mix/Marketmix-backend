require('dotenv').config();
const db = require('./config/db');

/**
 * Migration: Add order_reports table for buyer return/refund reports
 * Includes:
 * - Delivery confirmation timestamp
 * - Report submission with evidence
 */

async function addOrderReportsTable() {
  try {
    console.log('🔄 Starting migration: Adding order_reports table...\n');

    // 1. Add delivery_confirmed_at column to orders table if it doesn't exist
    console.log('📝 Adding delivery_confirmed_at column to orders table...');
    try {
      await db.query(`
        ALTER TABLE orders 
        ADD COLUMN delivery_confirmed_at TIMESTAMP NULL
      `);
      console.log('✅ Added delivery_confirmed_at column to orders table');
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('⚠️  Column already exists, skipping...');
      } else {
        throw err;
      }
    }

    // 2. Create order_reports table
    console.log('\n📝 Creating order_reports table...');
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS order_reports (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          reason VARCHAR(100) NOT NULL,
          description TEXT NOT NULL,
          evidence_url VARCHAR(500),
          status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'resolved', 'rejected', 'refunded')),
          seller_response TEXT,
          resolution_date TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(order_id, buyer_id) -- One report per order per buyer
        );
      `);
      console.log('✅ Created order_reports table successfully');
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('⚠️  Table already exists, skipping...');
      } else {
        throw err;
      }
    }

    // 3. Create indexes for better query performance
    console.log('\n📝 Creating indexes on order_reports table...');
    try {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_reports_buyer_id 
        ON order_reports(buyer_id);
      `);
      console.log('✅ Created index on buyer_id');

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_reports_order_id 
        ON order_reports(order_id);
      `);
      console.log('✅ Created index on order_id');

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_reports_status 
        ON order_reports(status);
      `);
      console.log('✅ Created index on status');

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_reports_created_at 
        ON order_reports(created_at DESC);
      `);
      console.log('✅ Created index on created_at');
    } catch (err) {
      console.log('⚠️  Indexes may already exist:', err.message);
    }

    // 4. Verify tables exist
    console.log('\n📊 Verifying tables...');
    const ordersCheck = await db.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'orders' AND column_name = 'delivery_confirmed_at'
    `);
    
    const reportsCheck = await db.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'order_reports'
    `);

    if (ordersCheck.rows.length > 0) {
      console.log('✅ orders table has delivery_confirmed_at column');
    } else {
      console.log('❌ orders table missing delivery_confirmed_at column');
    }

    if (reportsCheck.rows.length > 0) {
      console.log('✅ order_reports table created successfully');
    } else {
      console.log('❌ order_reports table not found');
    }

    console.log('\n✨ Migration completed successfully!\n');
    console.log('📋 Summary:');
    console.log('  - Added delivery_confirmed_at column to orders table');
    console.log('  - Created order_reports table with full schema');
    console.log('  - Created performance indexes');
    console.log('\n🚀 Ready to use order confirmation and reporting features!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await db.end();
    process.exit(0);
  }
}

// Run migration
addOrderReportsTable();
