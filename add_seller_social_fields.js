/*
 * Database Migration: Add website, facebook, and store_logo_url columns to seller_profiles table
 *
 * This script performs a safe migration by first checking if the columns
 * already exist before attempting to add them. It leaves all existing code
 * and data untouched.
 *
 * Usage:
 *   node add_seller_social_fields.js
 *
 * Make sure the environment variable DATABASE_URL points to the correct
 * Supabase/Postgres database.
 */

require('dotenv').config();
const { Pool } = require('pg');

async function addSellerSocialFields() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Starting migration: Adding social and website fields to seller_profiles...');

    // Define columns to add
    const columnsToAdd = [
      { name: 'website', type: 'VARCHAR(255)', nullable: true, default: null },
      { name: 'facebook', type: 'VARCHAR(255)', nullable: true, default: null },
      { name: 'store_logo_url', type: 'VARCHAR(500)', nullable: true, default: null }
    ];

    for (const column of columnsToAdd) {
      // check if column already exists
      const checkSQL = `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'seller_profiles' AND column_name = '${column.name}';
      `;
      const res = await pool.query(checkSQL);
      
      if (res.rows.length > 0) {
        console.log(`✅ Column ${column.name} already exists, skipping...`);
        continue;
      }

      // add the column
      let alterSQL = `
        ALTER TABLE seller_profiles
        ADD COLUMN ${column.name} ${column.type}
      `;

      if (column.nullable === false && column.default !== null) {
        alterSQL += ` NOT NULL DEFAULT '${column.default}'`;
      } else if (column.default !== null) {
        alterSQL += ` DEFAULT '${column.default}'`;
      }

      alterSQL += ';';

      await pool.query(alterSQL);
      console.log(`✅ Column ${column.name} added successfully`);
    }

    console.log('\n✨ All migrations completed successfully!');
    await pool.end();
  } catch (err) {
    console.error('❌ Error during migration:', err.message);
    console.error('Full error:', err);
    process.exit(1);
  }
}

addSellerSocialFields();
