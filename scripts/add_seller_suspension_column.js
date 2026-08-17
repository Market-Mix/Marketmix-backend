require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false;`);
    console.log('✅ done');
  } catch (error) {
    console.error('❌ Error adding seller suspension column:', error.message);
    process.exitCode = 1;
  } finally {
    await db.closePool();
    process.exit();
  }
})();
