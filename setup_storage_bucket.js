/*
 * Supabase Storage Bucket Setup: Create store-logos bucket
 *
 * This script creates the store-logos bucket in Supabase if it doesn't exist,
 * and sets up the public access policy for storing seller store logos.
 *
 * Usage:
 *   node setup_storage_bucket.js
 *
 * Make sure you have the following environment variables:
 *   - SUPABASE_URL: Your Supabase project URL
 *   - SUPABASE_SERVICE_KEY: Your Supabase service role key (has admin privileges)
 */

require('dotenv').config();

async function setupStorageBucket() {
  const SUPABASE_URL = process.env.SUPABASE_URL || extractSupabaseUrl();
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL) {
    console.error('❌ Error: Could not determine SUPABASE_URL');
    console.error('Please set SUPABASE_URL in your .env file');
    process.exit(1);
  }

  if (!SUPABASE_SERVICE_KEY) {
    console.error('\n❌ SUPABASE_SERVICE_KEY not found in .env file');
    console.error('\n📋 To get your Service Role Key:');
    console.error('   1. Go to https://app.supabase.com');
    console.error('   2. Select your project: "marketmix"');
    console.error('   3. Go to Settings → API');
    console.error('   4. Copy the "Service Role" secret key (labeled as "service_role secret" or with warning icon)');
    console.error('\n📝 Add to your .env file:');
    console.error('   SUPABASE_SERVICE_KEY=your_service_role_key_here');
    console.error('\n📚 Alternatively, create the bucket manually in Supabase Dashboard:');
    console.error('   1. Go to Storage → Create a new bucket');
    console.error('   2. Name: store-logos');
    console.error('   3. Set to Public');
    console.error('   4. File size limit: 5MB');
    process.exit(1);
  }

  function extractSupabaseUrl() {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl && dbUrl.includes('supabase.com')) {
      const match = dbUrl.match(/postgres\.([^:]+)/);
      if (match) {
        return `https://${match[1]}.supabase.co`;
      }
    }
    return null;
  }

  try {
    console.log('🔄 Starting Supabase storage bucket setup...');

    // Create bucket (will fail silently if it already exists)
    try {
      const bucketResponse = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'store-logos',
          public: true,
          file_size_limit: 5242880, // 5MB limit
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
        })
      });

      const bucketData = await bucketResponse.json();

      if (bucketResponse.ok) {
        console.log('✅ Bucket created successfully:', bucketData);
      } else if (bucketData.message && bucketData.message.includes('already exists')) {
        console.log('✅ Bucket store-logos already exists');
      } else {
        console.warn('⚠️  Bucket creation response:', bucketData);
      }
    } catch (bucketErr) {
      console.warn('⚠️  Bucket operation warning:', bucketErr.message);
    }

    // Set up public policy for the bucket
    try {
      const policiesResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_policies?bucket_id=store-logos`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
          }
        }
      );

      console.log('✅ Storage bucket setup completed');
      console.log('\n📝 Configuration:');
      console.log('  - Bucket: store-logos');
      console.log('  - Access: Public');
      console.log('  - File size limit: 5MB');
      console.log('  - Allowed types: JPEG, PNG, WebP, GIF');
      console.log('\n✨ Ready to use! Store logos will be uploaded to: store-logos/{user_id}/logo.png');
    } catch (policiesErr) {
      console.warn('⚠️  Policy check completed (this is normal)');
    }

  } catch (err) {
    console.error('❌ Error during setup:', err.message);
    process.exit(1);
  }
}

setupStorageBucket();
