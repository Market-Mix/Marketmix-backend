require('dotenv').config();
const { Pool } = require('pg');

async function inspect() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
  });

  try {
    console.log('1) RLS enabled for table users:');
    const rlsRes = await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass;");
    console.log('  - relrowsecurity:', rlsRes.rows[0] && rlsRes.rows[0].relrowsecurity);

    console.log('\n2) Policies on public.users:');
    const pols = await pool.query("SELECT policyname, permissive, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='users';");
    if (pols.rows.length === 0) console.log('  - (none)');
    else pols.rows.forEach(p => console.log(`  - ${p.policyname} | cmd=${p.cmd} | roles=${p.roles} | qual=${p.qual}`));

    console.log('\n3) Triggers on public.users:');
    const trigs = await pool.query("SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS ddl FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal;");
    if (trigs.rows.length === 0) console.log('  - (none)');
    else trigs.rows.forEach(t => console.log(`  - ${t.tgname} | enabled=${t.tgenabled} | def=${t.ddl.substring(0,200)}`));

    console.log('\n4) Quick SELECT recent users (id, email, role, created_at, updated_at, is_deleted):');
    try {
      const rows = await pool.query("SELECT id, email, role, created_at, updated_at, COALESCE(is_deleted,false) as is_deleted FROM public.users ORDER BY updated_at DESC LIMIT 20;");
      if (rows.rows.length === 0) console.log('  - (no rows returned)');
      else rows.rows.forEach(r => console.log(`  - ${r.email} | role=${r.role} | deleted=${r.is_deleted} | id=${r.id}`));
    } catch (err) {
      console.log('  - SELECT returned error (likely due to RLS):', err.message);
    }

    await pool.end();
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

inspect();
