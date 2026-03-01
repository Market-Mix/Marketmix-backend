/*
 * Database Migration: Add email_verified column to seller_profiles table
 *
 * This script performs a safe migration by first checking if the column
 * already exists before attempting to add it. It leaves all existing code
 * and data untouched.
 *
 * Usage:
 *   node add_email_verified_column.js
 *
 * Make sure the environment variable DATABASE_URL points to the correct
 * Supabase/Postgres database.
 */

require('dotenv').config();
const { Pool } = require('pg');

async function addEmailVerifiedColumn() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Starting migration: Adding email_verified column to seller_profiles...');

    // check if column already exists
    const checkSQL = `
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'seller_profiles' AND column_name = 'email_verified';
    `;
    const res = await pool.query(checkSQL);
    if (res.rows.length > 0) {
      console.log('✅ Column email_verified already exists, nothing to do');
      await pool.end();
      return;
    }

    // add the column
    const alterSQL = `
      ALTER TABLE seller_profiles
      ADD COLUMN email_verified BOOLEAN DEFAULT false NOT NULL;
    `;
    await pool.query(alterSQL);
    console.log('✅ Column added successfully');

    await pool.end();
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

addEmailVerifiedColumn();
