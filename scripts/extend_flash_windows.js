/*
  Script: extend_flash_windows.js
  Purpose: Extend flash sale windows for products that already have flash start/end timestamps.
  Usage (locally):
    DATABASE_URL="your_supabase_db_connection_string" node scripts/extend_flash_windows.js
  Caution: This updates rows in-place. Review the SQL and optionally run inside a transaction or backup.
*/

const { pool } = require('../config/db');

async function extendFlashWindows() {
  try {
    console.log('Starting flash windows extension...');

    // Customize intervals here if needed
    const startDelta = "1 day"; // subtract to start earlier
    const endDelta = "7 days";  // add to end later

    const updateSql = `
      UPDATE products
      SET "flash start" = ("flash start" - INTERVAL '${startDelta}')::timestamptz,
          "flash end" = ("flash end" + INTERVAL '${endDelta}')::timestamptz,
          updated_at = NOW()
      WHERE "flash start" IS NOT NULL AND "flash end" IS NOT NULL
      RETURNING id, "flash start" as flash_start, "flash end" as flash_end;
    `;

    const res = await pool.query(updateSql);
    console.log(`Updated ${res.rowCount} products.`);

    if (res.rowCount > 0) {
      console.log('Sample updated rows:');
      res.rows.slice(0, 10).forEach(r => console.log(r));
    }

  } catch (err) {
    console.error('Error extending flash windows:', err);
  } finally {
    await pool.end();
    console.log('Done. Pool closed.');
  }
}

extendFlashWindows();
