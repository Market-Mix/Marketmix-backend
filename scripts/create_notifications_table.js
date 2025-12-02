const db = require('../config/db');

/**
 * Create notifications table schema
 */
async function createNotificationsTable() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Create notifications table
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        data JSONB DEFAULT NULL,
        is_read BOOLEAN DEFAULT false,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await client.query(createTableQuery);
    console.log('✅ notifications table created successfully');

    // Create index on user_id for faster queries
    const createIndexQuery = `
      CREATE INDEX IF NOT EXISTS idx_notifications_user_id 
      ON notifications(user_id);
    `;

    await client.query(createIndexQuery);
    console.log('✅ Index on user_id created successfully');

    // Create index on user_id and is_read for filtering unread
    const createReadIndexQuery = `
      CREATE INDEX IF NOT EXISTS idx_notifications_user_read 
      ON notifications(user_id, is_read);
    `;

    await client.query(createReadIndexQuery);
    console.log('✅ Index on user_id and is_read created successfully');

    await client.query('COMMIT');
    console.log('✅ Notifications table schema created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.message.includes('already exists')) {
      console.log('⚠️  Notifications table already exists');
    } else {
      console.error('❌ Error creating notifications table:', error.message);
      throw error;
    }
  } finally {
    client.release();
  }
}

// Run the function
createNotificationsTable()
  .then(() => {
    console.log('🎉 Script completed successfully');
    process.exit(0);
  })
  .catch((err) => {
    console.error('💥 Script failed:', err);
    process.exit(1);
  });
