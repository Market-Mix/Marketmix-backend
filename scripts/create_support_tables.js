require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_number BIGSERIAL UNIQUE,
        user_id UUID NOT NULL REFERENCES users(id),
        subject VARCHAR(200) NOT NULL,
        category VARCHAR(40) NOT NULL DEFAULT 'general',
        priority VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
        status VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (status IN ('new','open','pending','waiting','escalated','resolved','closed')),
        order_id UUID,
        assigned_to UUID REFERENCES users(id),
        first_response_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_st_status ON support_tickets(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_st_user ON support_tickets(user_id);

      CREATE TABLE IF NOT EXISTS support_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(id),
        sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('user','support','system')),
        body TEXT NOT NULL,
        is_internal BOOLEAN DEFAULT false,
        attachments JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sm_ticket ON support_messages(ticket_id, created_at);
    `);
    console.log('Support tables ready');
  } catch (error) {
    console.error('Support tables migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.closePool();
  }
})();
