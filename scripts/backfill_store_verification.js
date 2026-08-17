require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    const r = await db.query(`
      UPDATE stores s
      SET is_verified = true,
          updated_at = NOW()
      FROM seller_profiles sp
      WHERE sp.user_id = s.user_id
        AND sp.is_verified = true
        AND s.is_verified = false
        AND s.is_deleted = false
      RETURNING s.id
    `);

    console.log(`✅ Backfilled ${r.rowCount} store(s)`);
  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.closePool();
    process.exit();
  }
})();
