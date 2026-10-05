require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    await db.query(`
      ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64),
        ADD COLUMN IF NOT EXISTS user_agent TEXT;
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
    `);
    console.log('✅ audit_logs upgraded');
  } catch (error) {
    console.error('audit_logs upgrade failed:', error);
    process.exitCode = 1;
  } finally {
    await db.closePool();
  }
})();
