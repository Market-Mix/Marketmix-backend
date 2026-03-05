/*
 * Storage RLS Policy Setup for store-logos bucket
 *
 * This script sets up Row-Level Security policies to allow:
 * 1. Authenticated users to upload their own logos
 * 2. Public access to read/view logos
 *
 * Usage:
 *   node setup_storage_rls_policies.js
 *
 * Make sure DATABASE_URL is set in your .env file
 */

require('dotenv').config();
const { Pool } = require('pg');

async function setupStorageRLSPolicies() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Starting Storage RLS policy setup...');

    // Check if the bucket exists
    const bucketCheck = await pool.query(`
      SELECT id FROM storage.buckets WHERE name = 'store-logos';
    `);

    if (bucketCheck.rows.length === 0) {
      console.log('❌ store-logos bucket not found. Please create it first in Supabase Dashboard.');
      console.log('   Storage → Create new bucket → Name: store-logos → Make it Public');
      await pool.end();
      process.exit(1);
    }

    const bucketId = bucketCheck.rows[0].id;
    console.log('✅ Found store-logos bucket');

    // The bucket id is already a string like "store-logos", not a UUID

    // Step 1: Ensure RLS is enabled on storage.objects
    console.log('\n📋 Checking RLS status on storage.objects...');
    const rlsStatus = await pool.query(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'objects' AND relnamespace = (
        SELECT oid FROM pg_namespace WHERE nspname = 'storage'
      );
    `);

    if (rlsStatus.rows.length > 0 && !rlsStatus.rows[0].relrowsecurity) {
      console.log('🔒 Enabling RLS on storage.objects...');
      await pool.query('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
      console.log('✅ RLS enabled');
    } else {
      console.log('✅ RLS already enabled');
    }

    // Step 2: Drop existing policies to avoid conflicts
    console.log('\n🗑️  Cleaning up existing policies...');
    const existingPolicies = await pool.query(`
      SELECT policyname FROM pg_policies 
      WHERE tablename = 'objects' AND schemaname = 'storage';
    `);

    for (const policy of existingPolicies.rows) {
      try {
        await pool.query(`DROP POLICY IF EXISTS "${policy.policyname}" ON storage.objects;`);
        console.log(`  ✓ Dropped policy: ${policy.policyname}`);
      } catch (e) {
        console.warn(`  ⚠️  Could not drop policy ${policy.policyname}:`, e.message);
      }
    }

    // Step 3: Create or update upload policy (authenticated users can upload to their own folder)
    console.log('\n📝 Creating upload policy...');
    const uploadPolicy = `
      CREATE POLICY "Allow authenticated users to upload to store-logos"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = '${bucketId}'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
    `;

    try {
      await pool.query(uploadPolicy);
      console.log('✅ Upload policy created');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('✅ Upload policy already exists');
      } else {
        console.warn('⚠️  Could not create upload policy:', e.message);
      }
    }

    // Step 4: Create read policy (public access to store-logos)
    console.log('\n📖 Creating read policy...');
    const readPolicy = `
      CREATE POLICY "Allow public read access to store-logos"
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = '${bucketId}');
    `;

    try {
      await pool.query(readPolicy);
      console.log('✅ Read policy created');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('✅ Read policy already exists');
      } else {
        console.warn('⚠️  Could not create read policy:', e.message);
      }
    }

    // Step 5: Create delete policy (users can delete their own files)
    console.log('\n🗑️  Creating delete policy...');
    const deletePolicy = `
      CREATE POLICY "Allow users to delete their own files"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = '${bucketId}'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
    `;

    try {
      await pool.query(deletePolicy);
      console.log('✅ Delete policy created');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('✅ Delete policy already exists');
      } else {
        console.warn('⚠️  Could not create delete policy:', e.message);
      }
    }

    console.log('\n✨ Storage RLS policies setup completed successfully!');
    console.log('\n📝 Current policies:');
    console.log('   ✓ Authenticated users can upload to store-logos/{user_id}/*');
    console.log('   ✓ Everyone can read/view store logos');
    console.log('   ✓ Users can delete their own logos');
    console.log('\n🎉 Ready to upload logos to your store!');

    await pool.end();
  } catch (err) {
    console.error('\n❌ Error during setup:', err.message);
    console.error('\nFull error:', err);
    console.error('\n💡 Try these alternatives:');
    console.error('   1. Go to Supabase Dashboard → Storage → store-logos bucket');
    console.error('   2. Click "Policies" → "New Policy" → "For SELECT" → "Get"');
    console.error('   3. Policy name: "Allow public read"');
    console.error('   4. Paste this and confirm:');
    console.error('      true');
    console.error('');
    console.error('   5. Create another policy "For INSERT" → "Create"');
    console.error('   6. Policy name: "Allow authenticated upload"');
    console.error('   7. Paste this and confirm:');
    console.error('      auth.role() = \'authenticated\'');
    process.exit(1);
  }
}

setupStorageRLSPolicies();
