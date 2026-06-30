require('dotenv').config();
const db = require('./config/db');

async function addPhase4ShipmentTrackingColumns() {
  try {
    console.log('🔄 Starting Phase 4 shipment tracking migration...');

    const statements = [
      {
        description: 'Add courier_name to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS courier_name VARCHAR(200) NULL`
      },
      {
        description: 'Add tracking_number to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(200) NULL`
      },
      {
        description: 'Add shipping_receipt_url to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS shipping_receipt_url TEXT NULL`
      },
      {
        description: 'Add shipment_notes to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS shipment_notes TEXT NULL`
      },
      {
        description: 'Add buyer_shipped_at to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS buyer_shipped_at TIMESTAMP WITH TIME ZONE NULL`
      },
      {
        description: 'Add shipping_status to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN IF NOT EXISTS shipping_status VARCHAR(50) NULL`
      }
    ];

    for (const stmt of statements) {
      try {
        console.log(`📝 ${stmt.description}...`);
        await db.query(stmt.query);
        console.log(`✅ ${stmt.description}`);
      } catch (err) {
        if (err.message && err.message.toLowerCase().includes('already exists')) {
          console.log(`⚠️  ${stmt.description} already exists, skipping.`);
        } else {
          throw err;
        }
      }
    }

    console.log('✅ Phase 4 shipment tracking migration complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

addPhase4ShipmentTrackingColumns();
