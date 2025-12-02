require('dotenv').config();
const { Pool } = require('pg');

async function replacePolicy() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
  });

  try {
    console.log('Dropping permissive debug policy if exists...');
    await pool.query("DROP POLICY IF EXISTS debug_allow_select_users ON public.users;");

    console.log('Creating safer policy allow_select_users_non_deleted (SELECT where is_deleted = false) if not exists...');
    // Check existing
    const exists = await pool.query("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='users' AND policyname='allow_select_users_non_deleted';");
    if (exists.rows.length === 0) {
      await pool.query("CREATE POLICY allow_select_users_non_deleted ON public.users FOR SELECT USING (COALESCE(is_deleted,false) = false);");
      console.log('Policy created.');
    } else {
      console.log('Policy already exists — leaving it in place.');
    }

    console.log('\nQuick SELECT to confirm visibility:');
    const res = await pool.query("SELECT id, email, role, created_at, updated_at, COALESCE(is_deleted,false) as is_deleted FROM public.users ORDER BY updated_at DESC LIMIT 20;");
    if (res.rows.length === 0) console.log('  - (no rows returned)');
    else res.rows.forEach(r => console.log(`  - ${r.email} | role=${r.role} | deleted=${r.is_deleted} | id=${r.id}`));

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

replacePolicy();
