const { Pool } = require('pg');

// Create PostgreSQL connection pool
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false // Required for Supabase
        }
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: {
          rejectUnauthorized: false
        }
      }
);

// Connection event handlers
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
  process.exit(-1);
});

// Query helper
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log('Executed query', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Get client from pool
const getClient = async () => {
  return await pool.connect();
};

// Close pool
const closePool = async () => {
  await pool.end();
  console.log('Database pool closed');
};

module.exports = {
  pool,
  query,
  transaction,
  getClient,
  closePool
};