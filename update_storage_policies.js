/*
 * Update Storage RLS Policies - Allow uploads without strict auth
 *
 * This script modifies the RLS policy to allow uploads from the browser
 * even when the user is not actively authenticated with Supabase
 * (recovering from localStorage).
 */

require('dotenv').config();
const { Pool } = require('pg');

async function updatePolicies() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Updating RLS policies...');

    // Get bucket ID
    const res = await pool.query(`SELECT id FROM storage.buckets WHERE name = 'store-logos'`);
    const bucketId = res.rows[0].id;

    // Drop the restrictive authenticated-only policy
    await pool.query(`DROP POLICY IF EXISTS "Allow authenticated users to upload to store-logos" ON storage.objects`);
    console.log('✓ Removed restrictive policy');

    // Create permissive upload policy
    await pool.query(`
      CREATE POLICY "Allow all uploads to store-logos"
      ON storage.objects
      FOR INSERT
      TO public
      WITH CHECK (bucket_id = '${bucketId}')
    `);
    console.log('✓ Created permissive upload policy');

    console.log('\n✅ RLS policies updated successfully!');
    console.log('Users can now upload logos to the store-logos bucket.');

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

updatePolicies();
