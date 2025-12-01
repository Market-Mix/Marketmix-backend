require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('Listing all tables in the database...\n');
    const result = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('Tables found:');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    // For each table, show its columns
    console.log('\n\nDetailed schema:\n');
    for (const row of result.rows) {
      const table = row.table_name;
      const colRes = await db.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1 
        ORDER BY ordinal_position
      `, [table]);
      
      console.log(`${table}:`);
      colRes.rows.forEach(col => {
        console.log(`  - ${col.column_name}: ${col.data_type}`);
      });
      console.log();
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.closePool();
    process.exit();
  }
})();
