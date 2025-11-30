require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    const tablesRes = await db.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY tablename");
    const tables = tablesRes.rows.map(r => r.tablename);
    console.log(JSON.stringify({ tables }, null, 2));

    for (const t of tables) {
      const cols = await db.query(
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position',
        [t]
      );

      const pkRes = await db.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1`,
        [t]
      );

      const fkRes = await db.query(
        `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
        [t]
      );

      // Row count - safe quoting of identifier
      const safeTable = '"' + t.replace(/"/g, '""') + '"';
      let rowCount = null;
      try {
        const rc = await db.query(`SELECT COUNT(*)::int AS count FROM public.${safeTable}`);
        rowCount = rc.rows[0].count;
      } catch (e) {
        rowCount = `ERROR: ${e.message}`;
      }

      console.log(JSON.stringify({
        table: t,
        columns: cols.rows,
        primary_keys: pkRes.rows.map(r => r.column_name),
        foreign_keys: fkRes.rows,
        row_count: rowCount
      }, null, 2));
    }
  } catch (err) {
    console.error('ERROR', err && err.message ? err.message : err);
    console.error(err && err.stack ? err.stack : err);
  } finally {
    // Close pool gracefully
    if (db && db.closePool) await db.closePool();
    process.exit();
  }
})();
