require('dotenv').config();
const { Pool } = require('pg');

async function createPolicy() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
  });

  try {
    console.log('Checking existing policies for public.users...');
    const pols = await pool.query("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='users' AND policyname='debug_allow_select_users';");
    if (pols.rows.length > 0) {
      console.log('Policy debug_allow_select_users already exists — leaving it in place.');
    } else {
      console.log('Creating policy debug_allow_select_users (temporary, allows SELECT for everyone)...');
      await pool.query("CREATE POLICY debug_allow_select_users ON public.users FOR SELECT USING (true);");
      console.log('Policy created.');
    }

    console.log('\nQuick SELECT to confirm visibility:');
    const res = await pool.query("SELECT id, email, role, created_at, updated_at, COALESCE(is_deleted,false) as is_deleted FROM public.users ORDER BY updated_at DESC LIMIT 20;");
    if (res.rows.length === 0) console.log('  - (no rows returned)');
    else res.rows.forEach(r => console.log(`  - ${r.email} | role=${r.role} | deleted=${r.is_deleted} | id=${r.id}`));

    console.log('\nDone. Reminder: This policy is permissive and should be removed after debugging if you require stricter access.');
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

createPolicy();
