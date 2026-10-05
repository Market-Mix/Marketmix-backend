require('dotenv').config();
const db = require('../config/db');
const { fullMatrix } = require('../utils/rbac');

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(60) NOT NULL, description TEXT DEFAULT '',
        access_level VARCHAR(20) NOT NULL DEFAULT 'Moderate Access'
          CHECK (access_level IN ('Full Access','High Access','Moderate Access','Limited Access','Read Only')),
        status VARCHAR(10) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Pending','Suspended')),
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_super BOOLEAN DEFAULT false, is_deleted BOOLEAN DEFAULT false,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE UNIQUE INDEX IF NOT EXISTS admin_roles_name_uidx ON admin_roles(LOWER(name)) WHERE NOT is_deleted;

      CREATE TABLE IF NOT EXISTS admin_members (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        role_id UUID REFERENCES admin_roles(id),
        department VARCHAR(60) DEFAULT 'General',
        status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','inactive')),
        custom_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        invited_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS admin_invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL, first_name VARCHAR(80), last_name VARCHAR(80),
        role_id UUID REFERENCES admin_roles(id), department VARCHAR(60) DEFAULT 'General',
        token_hash VARCHAR(64) NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
        invited_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_admin_inv_token ON admin_invitations(token_hash);
    `);

    let r = await db.query(`SELECT id FROM admin_roles WHERE is_super AND NOT is_deleted LIMIT 1`);
    if (!r.rows.length) {
      r = await db.query(
        `INSERT INTO admin_roles (name,description,access_level,permissions,is_super)
         VALUES ('Super Admin','Full platform control with all system permissions.','Full Access',$1,true) RETURNING id`,
        [JSON.stringify(fullMatrix('allowed'))]);
    }
    await db.query(
      `INSERT INTO admin_members (user_id, role_id) SELECT id, $1 FROM users WHERE role='admin' AND is_deleted=false
       ON CONFLICT DO NOTHING`, [r.rows[0].id]);

    console.log('✅ RBAC tables ready');
  } catch (error) {
    console.error('RBAC migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.closePool();
  }
})();
