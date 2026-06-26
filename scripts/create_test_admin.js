#!/usr/bin/env node
try {
  require('dotenv').config();
} catch (error) {
  // dotenv may not be installed in every local environment; continue without it.
}

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  console.error('❌ Development-only admin helper is disabled in production.');
  process.exit(1);
}

const bcrypt = require('bcrypt');
const db = require('../config/db');
const { generateToken } = require('../utils/jwt');

const email = process.env.TEST_ADMIN_EMAIL || 'dev.admin@example.com';
const password = process.env.TEST_ADMIN_PASSWORD || 'Admin123!';
const firstName = process.env.TEST_ADMIN_FIRST_NAME || 'MarketMix';
const lastName = process.env.TEST_ADMIN_LAST_NAME || 'Admin';

(async () => {
  try {
    const existingUser = await db.query('SELECT id, email, role FROM users WHERE email = $1', [email]);

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];
      await db.query(
        `UPDATE users
         SET role = 'admin',
             first_name = COALESCE($2, first_name),
             last_name = COALESCE($3, last_name),
             updated_at = NOW()
         WHERE id = $1`,
        [user.id, firstName, lastName]
      );
      console.log(`✅ Promoted existing user ${email} to admin.`);
    } else {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      const insertResult = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, email, role`,
        [email, passwordHash, firstName, lastName]
      );

      console.log(`✅ Created new admin user ${email}.`);
      console.log(`   Password: ${password}`);
      console.log(`   User ID: ${insertResult.rows[0].id}`);
    }

    const userResult = await db.query('SELECT id, email, role FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role
    });

    console.log('\n🔐 Admin JWT');
    console.log(token);
    console.log('\nUse this header:');
    console.log(`Authorization: Bearer ${token}`);
    console.log('\nExample admin refund calls:');
    console.log('curl -X POST http://localhost:' + (process.env.PORT || 5000) + '/api/admin/refunds/<refundId>/approve \\');
    console.log(`  -H "Authorization: Bearer ${token}"`);
    console.log('curl -X POST http://localhost:' + (process.env.PORT || 5000) + '/api/admin/refunds/<refundId>/reject \\');
    console.log(`  -H "Authorization: Bearer ${token}"`);
  } catch (error) {
    console.error('❌ Failed to create or promote admin user:');
    console.error('message:', error.message);
    console.error('stack:', error.stack);
    console.error('code:', error.code);
    console.error('detail:', error.detail);
    console.error('constraint:', error.constraint);
    console.error('table:', error.table);
    console.error('column:', error.column);
    if (error.original) {
      console.error('original error:', error.original);
    }
    process.exit(1);
  } finally {
    await db.closePool().catch(() => {});
  }
})();
