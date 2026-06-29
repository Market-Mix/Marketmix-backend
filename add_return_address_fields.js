require('dotenv').config();
const db = require('./config/db');

async function addReturnAddressFields() {
  try {
    console.log('🔄 Starting migration: Add return address snapshot and address2 fields...');

    const statements = [
      {
        description: 'Add return_address_line1 to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_address_line1 VARCHAR(500) NULL`
      },
      {
        description: 'Add return_address_line2 to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_address_line2 VARCHAR(500) NULL`
      },
      {
        description: 'Add return_city to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_city VARCHAR(200) NULL`
      },
      {
        description: 'Add return_state to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_state VARCHAR(200) NULL`
      },
      {
        description: 'Add return_postal_code to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_postal_code VARCHAR(100) NULL`
      },
      {
        description: 'Add return_country to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN return_country VARCHAR(200) NULL`
      },
      {
        description: 'Add buyer_return_deadline to refund_cases',
        query: `ALTER TABLE refund_cases ADD COLUMN buyer_return_deadline INTEGER NULL`
      },
      {
        description: 'Add address_line2 to users',
        query: `ALTER TABLE users ADD COLUMN address_line2 VARCHAR(500) NULL`
      },
      {
        description: 'Add address_line2 to addresses',
        query: `ALTER TABLE addresses ADD COLUMN address_line2 VARCHAR(500) NULL`
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

    console.log('✨ Migration complete. Verifying schema...');

    const verificationQueries = [
      {
        table: 'refund_cases',
        column: 'return_address_line1'
      },
      {
        table: 'refund_cases',
        column: 'return_address_line2'
      },
      {
        table: 'refund_cases',
        column: 'return_city'
      },
      {
        table: 'refund_cases',
        column: 'return_state'
      },
      {
        table: 'refund_cases',
        column: 'return_postal_code'
      },
      {
        table: 'refund_cases',
        column: 'return_country'
      },
      {
        table: 'refund_cases',
        column: 'buyer_return_deadline'
      },
      {
        table: 'users',
        column: 'address_line2'
      },
      {
        table: 'addresses',
        column: 'address_line2'
      }
    ];

    for (const check of verificationQueries) {
      const result = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [check.table, check.column]
      );
      if (result.rows.length > 0) {
        console.log(`✅ ${check.table}.${check.column} exists`);
      } else {
        console.log(`❌ ${check.table}.${check.column} missing`);
      }
    }

    console.log('✅ Return address migration finished successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await db.end();
    process.exit(0);
  }
}

addReturnAddressFields();
