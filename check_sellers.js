require('dotenv').config();
const { Pool } = require('pg');

async function checkSellers() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4
  });

  try {
    const res = await pool.query('SELECT id, email FROM sellers LIMIT 5');
    if (res.rows.length > 0) {
      console.log('Sellers found:');
      res.rows.forEach(s => console.log(`  - ${s.email} (${s.id})`));
    } else {
      console.log('No sellers found. Creating a test seller...');
      
      function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
      
      const sellerId = generateUUID();
      await pool.query(
        `INSERT INTO sellers (id, name, email, role, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [sellerId, 'Test Seller', 'seller@marketmix.com', 'seller']
      );
      console.log(`✅ Created seller: ${sellerId}`);
      console.log('Use this ID for seeding products.');
    }
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkSellers();
