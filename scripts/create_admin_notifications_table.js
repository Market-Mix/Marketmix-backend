require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;
    CREATE INDEX IF NOT EXISTS idx_notifications_broadcast ON notifications ((data->>'broadcast_id'));

    CREATE TABLE IF NOT EXISTS admin_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255) NOT NULL, subject VARCHAR(255), message TEXT NOT NULL,
      channel VARCHAR(10) NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','both')),
      audience VARCHAR(12) NOT NULL CHECK (audience IN ('all','buyers','sellers','admins','individual')),
      target_user_id UUID REFERENCES users(id),
      type VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (type IN ('system','user','seller')),
      priority VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
      link TEXT, banner_url TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed')),
      scheduled_for TIMESTAMPTZ, sent_at TIMESTAMPTZ,
      recipients INT DEFAULT 0, delivered INT DEFAULT 0, failed INT DEFAULT 0, error_message TEXT,
      created_by UUID REFERENCES users(id),
      is_deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_notif_status ON admin_notifications(status, scheduled_for);
  `);
  console.log('✅ done'); await db.closePool(); process.exit();
})();
