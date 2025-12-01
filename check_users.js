require('dotenv').config();
const { Pool } = require('pg');

async function checkUsers() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4
  });

  try {
    const res = await pool.query(`
      SELECT id, email, role FROM users LIMIT 10
    `);
    
    console.log('Users in database:');
    if (res.rows.length === 0) {
      console.log('  No users found');
    } else {
      res.rows.forEach(u => console.log(`  - ${u.email} (${u.role})`));
    }

    // Check seller_profiles
    const sellerProfiles = await pool.query(`
      SELECT id, user_id FROM seller_profiles LIMIT 5
    `);
    
    console.log(`\nSeller profiles: ${sellerProfiles.rows.length}`);
    if (sellerProfiles.rows.length > 0) {
      sellerProfiles.rows.forEach(s => console.log(`  - ${s.id} -> user: ${s.user_id}`));
    }

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkUsers();
